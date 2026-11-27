/**
 * How readable a laid-out graph is, in numbers, so two layouts can be compared on
 * more than one screenshot.
 *
 * Every measure counts something a reader trips over. Lower is better for all of
 * them.
 */

export interface Rect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Polyline {
  id: string;
  from: string;
  to: string;
  points: { x: number; y: number }[];
}

export interface LayoutMetrics {
  /** Places where two lines cross. */
  crossings: number;
  /** Corners, summed over every line. */
  bends: number;
  /**
   * Length, in pixels, where two lines between different boxes run on top of each
   * other and can't be told apart. Lines that end at the same box may join.
   */
  sharedLane: number;
  /** Lines that pass through a box other than their own two ends. */
  linesThroughBoxes: number;
  /** Total line length, in pixels. */
  length: number;
  /** The drawing's width × height, in thousands of square pixels. */
  area: number;
}

type Seg = { a: { x: number; y: number }; b: { x: number; y: number }; edge: number };

export function measureLayout(boxes: Rect[], lines: Polyline[]): LayoutMetrics {
  const segs: Seg[] = [];
  let bends = 0;
  let length = 0;
  lines.forEach((line, edge) => {
    const pts = line.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (a.x === b.x && a.y === b.y) continue;
      segs.push({ a, b, edge });
      length += Math.hypot(b.x - a.x, b.y - a.y);
    }
    bends += countBends(pts);
  });

  let crossings = 0;
  let sharedLane = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      if (s.edge === t.edge) continue;
      const overlap = collinearOverlap(s, t);
      if (overlap > 0) {
        // Lines into the same box, or out of the same box, may join on their last
        // stretch: that reads as one bus. Lines between four different boxes
        // that share a stretch can't be told apart.
        const ls = lines[s.edge]!;
        const lt = lines[t.edge]!;
        if (ls.to !== lt.to && ls.from !== lt.from) sharedLane += overlap;
        continue;
      }
      if (properlyCross(s, t)) crossings += 1;
    }
  }

  let linesThroughBoxes = 0;
  lines.forEach((line, edge) => {
    const mine = segs.filter((s) => s.edge === edge);
    const hit = boxes.some(
      (box) => box.id !== line.from && box.id !== line.to && mine.some((s) => segmentHitsRect(s, shrink(box, 2))),
    );
    if (hit) linesThroughBoxes += 1;
  });

  const xs = [...boxes.flatMap((b) => [b.x, b.x + b.width]), ...segs.flatMap((s) => [s.a.x, s.b.x])];
  const ys = [...boxes.flatMap((b) => [b.y, b.y + b.height]), ...segs.flatMap((s) => [s.a.y, s.b.y])];
  const area = xs.length ? ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 1000 : 0;

  return {
    crossings,
    bends,
    sharedLane: Math.round(sharedLane),
    linesThroughBoxes,
    length: Math.round(length),
    area: Math.round(area),
  };
}

function countBends(pts: { x: number; y: number }[]): number {
  let n = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-6) n += 1;
  }
  return n;
}

/** Length two segments share when they lie on one line, else 0. */
function collinearOverlap(s: Seg, t: Seg): number {
  const horizontal = (g: Seg) => Math.abs(g.a.y - g.b.y) < 0.5;
  const vertical = (g: Seg) => Math.abs(g.a.x - g.b.x) < 0.5;
  if (horizontal(s) && horizontal(t) && Math.abs(s.a.y - t.a.y) < 0.5) {
    return overlap1d(s.a.x, s.b.x, t.a.x, t.b.x);
  }
  if (vertical(s) && vertical(t) && Math.abs(s.a.x - t.a.x) < 0.5) {
    return overlap1d(s.a.y, s.b.y, t.a.y, t.b.y);
  }
  return 0;
}

function overlap1d(a1: number, a2: number, b1: number, b2: number): number {
  const lo = Math.max(Math.min(a1, a2), Math.min(b1, b2));
  const hi = Math.min(Math.max(a1, a2), Math.max(b1, b2));
  return Math.max(0, hi - lo);
}

/** Two segments cross at a point inside both, not where one ends. */
function properlyCross(s: Seg, t: Seg): boolean {
  const d = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = d(t.a, t.b, s.a);
  const d2 = d(t.a, t.b, s.b);
  const d3 = d(s.a, s.b, t.a);
  const d4 = d(s.a, s.b, t.b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function shrink(r: Rect, by: number): Rect {
  return { ...r, x: r.x + by, y: r.y + by, width: r.width - 2 * by, height: r.height - 2 * by };
}

/** Whether a segment passes through the inside of a rectangle. */
function segmentHitsRect(s: Seg, r: Rect): boolean {
  const inside = (p: { x: number; y: number }) => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;
  if (inside(s.a) || inside(s.b)) return true;
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
  for (let i = 0; i < 4; i++) {
    if (properlyCross(s, { a: corners[i]!, b: corners[(i + 1) % 4]!, edge: -1 })) return true;
  }
  return false;
}
