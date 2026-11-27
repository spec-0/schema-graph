/**
 * Compare today's layout (dagre boxes, React Flow smooth-step lines) with ELK on
 * real specs: scores in a table, and both drawings side by side as SVG.
 *
 *   npm run build && node scripts/compare-layouts.mjs <out-dir> <spec>...
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { getSmoothStepPath, Position } from "@xyflow/system";
import { buildSchemaGraph, computeView, defaultFocus, edgeRoute, referenceLabel } from "../dist/index.js";
import { computeRoutedView, ELK_OPTIONS } from "../dist/elk.js";
import { measureLayout } from "../dist/layout-metrics.js";

const [outDir, ...specs] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const HANDLES = {
  forward: [Position.Right, Position.Left],
  backward: [Position.Bottom, Position.Bottom],
  self: [Position.Right, Position.Top],
};
const handlePoint = (n, pos) =>
  pos === Position.Right ? { x: n.x + n.width, y: n.y + n.height / 2 }
  : pos === Position.Left ? { x: n.x, y: n.y + n.height / 2 }
  : pos === Position.Top ? { x: n.x + n.width / 2, y: n.y }
  : { x: n.x + n.width / 2, y: n.y + n.height };

/** Today's lines: React Flow's smooth step between the handles the 0.3.0 view picks. */
function currentLayout(graph, opts) {
  const view = computeView(graph, opts);
  const byNode = new Map(view.nodes.map((n) => [n.id, n]));
  const byId = new Map(graph.schemas.map((s) => [s.id, s]));
  const lines = view.edges.map((e) => {
    const s = byNode.get(e.from), t = byNode.get(e.to);
    const route = edgeRoute(e.from, e.to, s, t);
    const [sp, tp] = HANDLES[route];
    const a = handlePoint(s, sp), b = handlePoint(t, tp);
    const [path, lx, ly] = getSmoothStepPath({ sourceX: a.x, sourceY: a.y, sourcePosition: sp, targetX: b.x, targetY: b.y, targetPosition: tp, borderRadius: 0, offset: 20 });
    const nums = path.match(/-?\d+(\.\d+)?/g).map(Number);
    const points = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const p = { x: nums[i], y: nums[i + 1] };
      const last = points[points.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) points.push(p);
    }
    const from = byId.get(e.from), to = byId.get(e.to);
    const text = e.kind === "references" && from && to ? referenceLabel(from, to.name) : undefined;
    return { id: `${e.from}->${e.to}`, from: e.from, to: e.to, kind: e.kind, points, label: text ? { text, x: lx - text.length * 3.1, y: ly - 7 } : undefined };
  });
  return { nodes: view.nodes, lines };
}

/** ELK settings tried on every graph; the best-scoring one is kept. */
const VARIANTS = {
  "fields+simplex": [ELK_OPTIONS, { fieldPorts: true }],
  "fields+bk": [{ ...ELK_OPTIONS, "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF", "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED" }, { fieldPorts: true }],
  "header+simplex": [ELK_OPTIONS, { fieldPorts: false }],
  "header+bk": [{ ...ELK_OPTIONS, "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF", "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED" }, { fieldPorts: false }],
};
/** One number per layout; what a reader trips over most weighs most. */
const score = (m) => m.crossings * 10 + m.linesThroughBoxes * 25 + m.sharedLane / 40 + m.bends * 1.5 + m.length / 150 + m.area / 60;

async function elkLayout(graph, opts, variant) {
  const [layoutOptions, extra] = VARIANTS[variant];
  const v = await computeRoutedView(graph, opts, layoutOptions, extra);
  return { nodes: v.nodes, lines: v.routes.map((r) => ({ ...r, label: r.label && { text: r.label.text, x: r.label.x, y: r.label.y } })) };
}

function svg({ nodes, lines }, title) {
  const xs = nodes.flatMap((n) => [n.x, n.x + n.width]).concat(lines.flatMap((l) => l.points.map((p) => p.x)));
  const ys = nodes.flatMap((n) => [n.y, n.y + n.height]).concat(lines.flatMap((l) => l.points.map((p) => p.y)));
  const minX = Math.min(...xs) - 20, minY = Math.min(...ys) - 40, w = Math.max(...xs) - minX + 20, h = Math.max(...ys) - minY + 20;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const boxes = nodes.map((n) => {
    const name = n.data.kind === "schema" ? n.data.name : `${n.data.method} ${n.data.path}`;
    const fields = n.data.kind === "schema" ? n.data.fields.slice(0, 4).map((f, i) => `<text x="${n.x + 10}" y="${n.y + 34 + i * 18 + 13}" class="f">${esc(f.name)}</text><text x="${n.x + n.width - 10}" y="${n.y + 34 + i * 18 + 13}" class="f t" text-anchor="end">${esc(f.type)}</text>`).join("") : "";
    return `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="8" class="${n.data.kind === "schema" ? "box" : "op"}"/><text x="${n.x + 10}" y="${n.y + 21}" class="n">${esc(name)}</text>${fields}`;
  }).join("");
  const paths = lines.map((l) => `<polyline points="${l.points.map((p) => `${p.x},${p.y}`).join(" ")}" class="${l.kind === "uses" ? "use" : "ref"}"/>`).join("");
  const labels = lines.filter((l) => l.label).map((l) => `<text x="${l.label.x + 4}" y="${l.label.y + 11}" class="l">${esc(l.label.text)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}" width="${w}" height="${h}">
<style>.box{fill:#17171c;stroke:#3a3a44}.op{fill:#1f1f26;stroke:#3a3a44}.n{fill:#eee;font:600 13px ui-monospace,monospace}.f{fill:#aaa;font:11px ui-monospace,monospace}.t{fill:#8c84ff}.ref{fill:none;stroke:#7c6cff;stroke-width:1.5}.use{fill:none;stroke:#888;stroke-width:1.2;stroke-dasharray:4 3}.l{fill:#999;font:10px ui-monospace,monospace;paint-order:stroke;stroke:#0e0e12;stroke-width:4px}.title{fill:#fff;font:600 16px system-ui}</style>
<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#0e0e12"/><text x="${minX + 12}" y="${minY + 24}" class="title">${esc(title)}</text>${paths}${boxes}${labels}</svg>`;
}

const rows = [];
for (const spec of specs) {
  const name = basename(spec).replace(/\.(ya?ml|json)$/, "");
  const graph = buildSchemaGraph(readFileSync(spec, "utf8"));
  const focus = defaultFocus(graph);
  const scenarios = {
    opening: { focus, expanded: new Set(focus ? [focus] : []) },
    "with operations": { focus, expanded: new Set(focus ? [focus] : []), showOperations: true },
    everything: { focus, expanded: new Set(graph.schemas.map((s) => s.id)), maxNeighbours: Infinity },
  };
  for (const [scenario, opts] of Object.entries(scenarios)) {
    const now = currentLayout(graph, opts);
    const m1 = measureLayout(now.nodes, now.lines);
    const file = `${name}-${scenario.replace(/ /g, "-")}`;
    writeFileSync(`${outDir}/${file}-now.svg`, svg(now, `${name} · ${scenario} · today (score ${score(m1).toFixed(0)})`));
    const tried = {};
    let best;
    for (const variant of Object.keys(VARIANTS)) {
      const elk = await elkLayout(graph, opts, variant);
      const m = measureLayout(elk.nodes, elk.lines);
      tried[variant] = { ...m, score: Math.round(score(m)) };
      writeFileSync(`${outDir}/${file}-${variant}.svg`, svg(elk, `${name} · ${scenario} · ELK ${variant} (score ${score(m).toFixed(0)})`));
      if (!best || score(m) < score(best.m)) best = { variant, m, elk };
    }
    writeFileSync(`${outDir}/${file}-elk.svg`, svg(best.elk, `${name} · ${scenario} · ELK best: ${best.variant} (score ${score(best.m).toFixed(0)})`));
    rows.push({ spec: name, scenario, boxes: now.nodes.length, lines: now.lines.length, now: { ...m1, score: Math.round(score(m1)) }, elk: { ...best.m, score: Math.round(score(best.m)) }, best: best.variant, tried });
  }
}
writeFileSync(`${outDir}/metrics.json`, JSON.stringify(rows, null, 2));
const keys = ["score", "crossings", "bends", "sharedLane", "linesThroughBoxes", "length", "area"];
console.log(["spec", "scenario", "boxes/lines", "best", ...keys.map((k) => `${k} now→elk`)].join(" | "));
for (const r of rows) console.log([r.spec, r.scenario, `${r.boxes}/${r.lines}`, r.best, ...keys.map((k) => `${r.now[k]}→${r.elk[k]}`)].join(" | "));
console.log("\nscore by variant:");
for (const r of rows) console.log(r.spec, r.scenario, Object.entries(r.tried).map(([k, v]) => `${k}=${v.score}`).join(" "));
