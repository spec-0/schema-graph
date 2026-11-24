import dagre from "@dagrejs/dagre";
import type { FieldSummary, GraphEdge, OperationNode, SchemaGraph, SchemaNode } from "./types.js";

/**
 * Pure view-model for the canvas: which nodes are visible under progressive
 * disclosure, and where they sit (dagre layout). Kept free of React so the
 * expansion/layout behaviour is unit-testable without a browser.
 */

export interface ViewOptions {
  /**
   * Draw nodes for structureless schemas (see `SchemaNode.simple`). Off by
   * default: they carry no structure to reveal, and in hand-written specs they
   * can be half the canvas. Their type still shows on the field that references
   * them, so nothing is lost — only a box that said `string`.
   */
  showSimple?: boolean;
  /** Schema to start from. Default: the most-connected schema. */
  focus?: string;
  /** Ids the user has expanded (each expansion reveals one hop of neighbours). */
  expanded: ReadonlySet<string>;
  /** Show operation nodes attached to visible schemas. Default false (schema-centric). */
  showOperations?: boolean;
  /**
   * Most neighbours to reveal per expansion. Large specs make "one hop" enormous — a 293-schema
   * document turns a couple of expansions into an unreadable wall — so the hop is capped and the
   * remainder is REPORTED (see {@link View.truncated}) rather than silently dropped.
   * Default 12; pass Infinity to disable.
   */
  maxNeighbours?: number;
  /**
   * Positions the user has dragged. These win over layout, so arranging the canvas by hand
   * survives expanding, collapsing and toggling.
   */
  pinned?: Record<string, { x: number; y: number }>;
}

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: SchemaNode | OperationNode;
}

export interface View {
  nodes: PositionedNode[];
  edges: GraphEdge[];
  /** The resolved focus id (useful when the caller passed none). */
  focus?: string;
  /** Where a hop was capped: how many neighbours were shown out of how many exist. */
  truncated: { nodeId: string; shown: number; total: number }[];
}

const SCHEMA_W = 220;
const SCHEMA_H = 72;
const OP_W = 240;
const OP_H = 44;

/** Cap on neighbours revealed per hop — see ViewOptions.maxNeighbours. */
export const DEFAULT_MAX_NEIGHBOURS = 12;

/**
 * How many of a schema's fields its node lists. A node that only says "5 fields"
 * makes the reader click every box to learn what's in it; the first few fields,
 * with their types, answer most of that at a glance.
 */
export const PREVIEW_FIELDS = 4;

/** The fields a schema's node lists, and how many more there are. */
export function fieldPreview(schema: SchemaNode, limit = PREVIEW_FIELDS): { fields: FieldSummary[]; more: number } {
  const fields = schema.fields.slice(0, limit);
  return { fields, more: schema.fields.length - fields.length };
}

// The node's parts, in pixels: the header with the name, one line per listed
// field, and a "+N more" line. Layout needs the real height, or dagre packs
// taller nodes into each other.
const HEADER_H = 34;
const FIELD_LINE_H = 18;
const NODE_PAD_B = 8;

/** A schema node's height, given the fields it lists. */
export function schemaHeight(schema: SchemaNode): number {
  const { fields, more } = fieldPreview(schema);
  const lines = fields.length + (more > 0 ? 1 : 0);
  return lines === 0 ? SCHEMA_H - 28 : HEADER_H + lines * FIELD_LINE_H + NODE_PAD_B;
}

/** A schema node's width: wide enough for its name and its listed fields, within limits. */
export function schemaWidth(schema: SchemaNode): number {
  const name = widthForLabel(schema.name);
  const longest = fieldPreview(schema).fields.reduce((most, f) => Math.max(most, f.name.length + f.type.length + 3), 0);
  return Math.round(Math.max(name, Math.min(420, 24 + longest * 6.8)));
}

/** The schema a field's type names, if any: `Address` and `Address[]` both name Address. */
export function referencedName(type: string): string {
  return type.replace(/(\[\])+$/, "");
}

/**
 * What labels a `references` edge: the fields of `from` whose type is `to`.
 * Undefined when the reference is deeper than a direct field (inside `allOf`, a
 * map, a nested object), where there's no single field to name.
 */
export function referenceLabel(from: SchemaNode, to: string): string | undefined {
  const names = from.fields.filter((f) => referencedName(f.type) === to).map((f) => f.name);
  return names.length ? names.join(", ") : undefined;
}

/**
 * Box width for a label. Generated specs produce names like
 * `github.com-mailgun-scaffold-httpapi-paging-PagingResponse` (57 chars); at a fixed 220px every
 * such node renders as an ellipsis, which is the same as having no label at all.
 */
export function widthForLabel(label: string, min = SCHEMA_W, max = 420): number {
  const estimated = 28 + label.length * 7.2;
  return Math.round(Math.max(min, Math.min(max, estimated)));
}

/** The most-connected schema — the default landing focus for a document. */
export function defaultFocus(graph: SchemaGraph): string | undefined {
  let best: string | undefined;
  let bestDegree = -1;
  for (const s of graph.schemas) {
    const degree = s.references.length + s.referencedBy.length;
    if (degree > bestDegree) {
      best = s.id;
      bestDegree = degree;
    }
  }
  return best;
}

/**
 * Visible schema ids: the focus, everything expanded, and one hop of neighbours
 * around each expanded node (and the focus). Deterministic for a given input.
 */
export function visibleSchemaIds(graph: SchemaGraph, options: ViewOptions): Set<string> {
  const drawable = (s: SchemaNode) => options.showSimple === true || !s.simple;
  const byId = new Map(graph.schemas.map((s) => [s.id, s]));
  const focus = options.focus ?? defaultFocus(graph);
  const visible = new Set<string>();
  if (!focus || !byId.has(focus)) {
    // No focus resolvable (e.g. no schemas): show everything small specs have.
    for (const s of graph.schemas) if (drawable(s)) visible.add(s.id);
    return visible;
  }

  const roots = new Set<string>([focus, ...options.expanded]);
  const cap = options.maxNeighbours ?? DEFAULT_MAX_NEIGHBOURS;
  for (const root of roots) {
    const node = byId.get(root);
    if (!node) continue;
    // An explicitly focused or expanded schema is always drawn, even if simple —
    // the user asked for it by name.
    visible.add(root);
    const neighbours = drawableNeighbours(node, byId, drawable);
    for (const neighbour of neighbours.slice(0, cap)) visible.add(neighbour);
  }
  return visible;
}

/** Neighbours of a node that are worth drawing, in deterministic order. */
function drawableNeighbours(
  node: SchemaNode,
  byId: Map<string, SchemaNode>,
  drawable: (s: SchemaNode) => boolean,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...node.references, ...node.referencedBy]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (n && drawable(n)) out.push(id);
  }
  // Stable order so the same graph always caps to the same neighbours.
  return out.sort((a, b) => a.localeCompare(b));
}

/** Build the positioned view for the current disclosure state. */
export function computeView(graph: SchemaGraph, options: ViewOptions): View {
  const focus = options.focus ?? defaultFocus(graph);
  const visible = visibleSchemaIds(graph, { ...options, focus });

  const schemaNodes = graph.schemas.filter((s) => visible.has(s.id));
  const operationNodes = options.showOperations
    ? graph.operations.filter((op) => op.uses.some((u) => visible.has(u)))
    : [];

  const edges = graph.edges.filter((e) => {
    if (e.kind === "references") return visible.has(e.from) && visible.has(e.to);
    return (
      options.showOperations === true &&
      operationNodes.some((op) => op.id === e.from) &&
      visible.has(e.to)
    );
  });

  const g = new dagre.graphlib.Graph();
  // Roomier than the defaults: dense specs were legible arithmetically but unreadable on screen.
  g.setGraph({ rankdir: "LR", nodesep: 56, ranksep: 140, marginx: 32, marginy: 32 });
  g.setDefaultEdgeLabel(() => ({}));
  const widths = new Map<string, number>();
  const heights = new Map<string, number>();
  for (const s of schemaNodes) {
    const width = schemaWidth(s);
    const height = schemaHeight(s);
    widths.set(s.id, width);
    heights.set(s.id, height);
    g.setNode(s.id, { width, height });
  }
  for (const op of operationNodes) {
    const width = widthForLabel(`${op.method} ${op.path}`, OP_W);
    widths.set(op.id, width);
    g.setNode(op.id, { width, height: OP_H });
  }
  for (const e of edges) g.setEdge(e.from, e.to);
  dagre.layout(g);

  const pinned = options.pinned ?? {};
  const positioned: PositionedNode[] = [];
  for (const s of schemaNodes) {
    const n = g.node(s.id);
    const width = widths.get(s.id) ?? SCHEMA_W;
    const height = heights.get(s.id) ?? SCHEMA_H;
    const at = pinned[s.id];
    positioned.push({
      id: s.id,
      x: at ? at.x : n.x - width / 2,
      y: at ? at.y : n.y - height / 2,
      width,
      height,
      data: s,
    });
  }
  for (const op of operationNodes) {
    const n = g.node(op.id);
    const width = widths.get(op.id) ?? OP_W;
    const at = pinned[op.id];
    positioned.push({
      id: op.id,
      x: at ? at.x : n.x - width / 2,
      y: at ? at.y : n.y - OP_H / 2,
      width,
      height: OP_H,
      data: op,
    });
  }

  // Report every hop we capped, so the UI can offer the rest instead of pretending
  // the neighbours it withheld do not exist.
  const byId = new Map(graph.schemas.map((s) => [s.id, s]));
  const drawable = (s: SchemaNode) => options.showSimple === true || !s.simple;
  const cap = options.maxNeighbours ?? DEFAULT_MAX_NEIGHBOURS;
  const truncated: View["truncated"] = [];
  for (const root of new Set<string>([focus ?? "", ...options.expanded])) {
    const node = root ? byId.get(root) : undefined;
    if (!node) continue;
    const total = drawableNeighbours(node, byId, drawable).length;
    if (total > cap) truncated.push({ nodeId: root, shown: cap, total });
  }

  return { nodes: positioned, edges, focus, truncated };
}

/** A box on the canvas, where it is now: laid out, or where the user dragged it. */
export interface Box {
  x: number;
  y: number;
  width: number;
}

/**
 * How a line between two boxes is drawn.
 *
 * - `forward`: the target is to the right, so the line leaves the right side and comes
 *   in on the left, as the layout intends.
 * - `backward`: the target is level with or behind the source. A line from the right
 *   side to the left side would swing back across the whole row, over the boxes in
 *   between, so it leaves from the bottom and comes in at the bottom instead, and
 *   runs under the row.
 * - `self`: a schema that refers to itself. The line loops from the right side over
 *   the top of the box.
 *
 * Decided from where the boxes are now, not from the layout, so a line still takes
 * the right route after the user drags a box behind the one it points to.
 */
export type EdgeRoute = "forward" | "backward" | "self";

/** Room the line needs between two boxes before it can run straight across. */
export const FORWARD_GAP = 24;

export function edgeRoute(from: string, to: string, source: Box | undefined, target: Box | undefined): EdgeRoute {
  if (from === to) return "self";
  if (!source || !target) return "forward";
  return target.x >= source.x + source.width + FORWARD_GAP ? "forward" : "backward";
}
