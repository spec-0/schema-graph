import dagre from "@dagrejs/dagre";

/**
 * A typed graph of arbitrary entities — the general model behind the schema view.
 *
 * Where the schema view derives its graph from a spec and decides visibility itself, a typed graph
 * arrives already decided: the producer (a server applying level-of-detail, say) has chosen what
 * belongs on screen. This module's only jobs are therefore layout and stability.
 */

export interface TypedNode {
  id: string;
  /** Free-form: the consumer decides the vocabulary and the styling that goes with it. */
  kind: string;
  label: string;
  sublabel?: string;
  /** What a collapsed node stands for, e.g. `{ apis: 12, schemas: 340 }`. */
  counts?: Record<string, number>;
  /** Where clicking through goes; absent when the node has no page of its own. */
  href?: string;
}

export interface TypedEdge {
  from: string;
  to: string;
  kind: string;
  /** Set on rolled-up edges — how many underlying facts the arrow stands for. */
  count?: number;
}

export interface TypedGraph {
  nodes: TypedNode[];
  edges: TypedEdge[];
}

export interface PositionedTypedNode extends TypedNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TypedView {
  nodes: PositionedTypedNode[];
  edges: TypedEdge[];
}

export interface TypedLayoutOptions {
  /**
   * Positions from the previous render. Nodes present here keep their exact coordinates, so
   * toggling a node type or expanding a node adds and removes boxes without reshuffling the ones
   * the user was already looking at. New nodes are placed relative to them.
   */
  previous?: Record<string, { x: number; y: number }>;
  /** Layout direction. Default "LR". */
  direction?: "LR" | "TB";
  /** Per-kind box size; falls back to a sensible default. */
  sizeFor?: (node: TypedNode) => { width: number; height: number };
}

const DEFAULT_SIZE = { width: 200, height: 64 };

/**
 * Lay out a typed graph, preserving the positions of nodes that were already on screen.
 *
 * Determinism matters as much as stability: nodes and edges are sorted by id before dagre runs, so
 * the same graph always produces the same coordinates regardless of the order the server happened
 * to serialise them in.
 */
export function layoutTypedGraph(
  graph: TypedGraph,
  options: TypedLayoutOptions = {},
): TypedView {
  const { previous, direction = "LR", sizeFor } = options;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 48, ranksep: 96, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const present = new Set(nodes.map((n) => n.id));
  const edges = [...graph.edges]
    .filter((e) => present.has(e.from) && present.has(e.to))
    .sort((a, b) => (a.from + a.to + a.kind).localeCompare(b.from + b.to + b.kind));

  const sizes = new Map<string, { width: number; height: number }>();
  for (const node of nodes) {
    const size = sizeFor?.(node) ?? DEFAULT_SIZE;
    sizes.set(node.id, size);
    g.setNode(node.id, { ...size });
  }
  for (const edge of edges) {
    g.setEdge(edge.from, edge.to);
  }
  dagre.layout(g);

  // Align this layout with the previous one: shift everything so the nodes that survived land
  // where they already were, then pin them exactly. Without the shift, new nodes would be placed
  // in a coordinate space unrelated to what the user is looking at.
  let dx = 0;
  let dy = 0;
  if (previous) {
    const shared = nodes.filter((n) => previous[n.id]);
    if (shared.length > 0) {
      let sumX = 0;
      let sumY = 0;
      for (const node of shared) {
        const laid = g.node(node.id);
        sumX += previous[node.id]!.x - laid.x;
        sumY += previous[node.id]!.y - laid.y;
      }
      dx = sumX / shared.length;
      dy = sumY / shared.length;
    }
  }

  const positioned: PositionedTypedNode[] = nodes.map((node) => {
    const laid = g.node(node.id);
    const size = sizes.get(node.id) ?? DEFAULT_SIZE;
    const pinned = previous?.[node.id];
    return {
      ...node,
      width: size.width,
      height: size.height,
      x: pinned ? pinned.x : laid.x + dx,
      y: pinned ? pinned.y : laid.y + dy,
    };
  });

  return { nodes: positioned, edges };
}

/** Convenience: the positions of a laid-out view, ready to pass back as `previous`. */
export function positionsOf(view: TypedView): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const node of view.nodes) {
    out[node.id] = { x: node.x, y: node.y };
  }
  return out;
}
