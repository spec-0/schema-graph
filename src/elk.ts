import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode, ElkPort, LayoutOptions } from "elkjs/lib/elk-api.js";
import type { SchemaGraph, SchemaNode } from "./types.js";
import {
  computeView,
  fieldPreview,
  fieldRowMiddle,
  NAME_MIDDLE,
  OP_H,
  referenceLabel,
  referencedName,
  type View,
  type ViewOptions,
} from "./viewmodel.js";

/**
 * Layout with ELK's layered algorithm (the Eclipse Layout Kernel), which places the
 * boxes and routes the lines in one pass.
 *
 * What it adds over placing boxes alone:
 *
 * - Lines are routed orthogonally around the boxes, with every bend worked out, and
 *   lines that would share a lane are spaced apart.
 * - A line leaves from the row of the field that refers (`customer` on Order), not
 *   from the middle of the box, so the reader can see which field a line belongs to.
 * - Crossings are reduced by re-ordering each column several times, not once.
 * - Labels are placed as part of the layout, so they don't land on each other.
 *
 * Which boxes are on the canvas is still decided by {@link computeView}; this only
 * decides where they go and how the lines run.
 */

/** A point on a routed line. */
export interface Point {
  x: number;
  y: number;
}

/** A line with its route: start, every bend, end. */
export interface RoutedEdge {
  id: string;
  from: string;
  to: string;
  kind: "references" | "uses";
  points: Point[];
  /** Where ELK placed the label, its top-left corner, if the line has one. */
  label?: { text: string; x: number; y: number; width: number; height: number };
}

export interface RoutedView extends Omit<View, "edges"> {
  edges: View["edges"];
  routes: RoutedEdge[];
  /** The laid-out graph's size. */
  width: number;
  height: number;
}

/** Where an incoming line meets a box: level with the name. */
const HEADER_PORT_Y = NAME_MIDDLE;
const LABEL_CHAR_W = 6.2;
const LABEL_H = 14;

/** ELK's settings. Spacing is roomier than ELK's defaults, which are made for small boxes. */
export const ELK_OPTIONS: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "90",
  "elk.spacing.nodeNode": "40",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.spacing.edgeEdge": "14",
  "elk.spacing.edgeNode": "20",
  "elk.spacing.edgeLabel": "4",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.thoroughness": "20",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.cycleBreaking.strategy": "GREEDY",
  "elk.layered.mergeEdges": "false",
  "elk.edgeLabels.inline": "true",
  "elk.padding": "[top=32,left=32,bottom=32,right=32]",
};

let elk: InstanceType<typeof ELK> | undefined;

/** Run ELK on the boxes and lines {@link computeView} chose. */
export async function computeRoutedView(
  graph: SchemaGraph,
  options: ViewOptions,
  layoutOptions: LayoutOptions = ELK_OPTIONS,
  { fieldPorts = true }: { fieldPorts?: boolean } = {},
): Promise<RoutedView> {
  const view = computeView(graph, { ...options, pinned: undefined });
  const byId = new Map(graph.schemas.map((s) => [s.id, s]));

  const portsOf = new Map<string, ElkPort[]>();
  const addPort = (node: string, port: ElkPort) => {
    const list = portsOf.get(node) ?? [];
    if (!list.some((p) => p.id === port.id)) list.push(port);
    portsOf.set(node, list);
  };

  const edges: ElkExtendedEdge[] = [];
  const meta = new Map<string, { from: string; to: string; kind: "references" | "uses"; label?: string }>();
  for (const e of view.edges) {
    const id = `${e.kind}:${e.from}->${e.to}`;
    const source = byId.get(e.from);
    const target = byId.get(e.to);
    const width = view.nodes.find((n) => n.id === e.from)?.width ?? 220;

    // The source port: on the referring field's row when the box lists that field,
    // on its "+N more" row when the field is one of those, otherwise level with
    // the name.
    let sourcePort = `${e.from}::out`;
    let sourceY = HEADER_PORT_Y;
    if (e.kind === "references" && source && target) {
      const row = fieldRow(source, target.name);
      if (row !== undefined) {
        sourcePort = `${e.from}::field:${row}`;
        sourceY = fieldRowMiddle(row);
      }
    }
    if (e.kind === "uses") {
      // An operation box is one line; its line leaves from the middle.
      sourceY = OP_H / 2;
    }
    addPort(e.from, {
      id: sourcePort,
      x: width,
      y: sourceY,
      width: 0,
      height: 0,
      layoutOptions: { "elk.port.side": "EAST" },
    });
    const targetPort = `${e.to}::in`;
    addPort(e.to, {
      id: targetPort,
      x: 0,
      y: HEADER_PORT_Y,
      width: 0,
      height: 0,
      layoutOptions: { "elk.port.side": "WEST" },
    });

    const label = e.kind === "references" && source && target ? referenceLabel(source, target.name) : undefined;
    meta.set(id, { from: e.from, to: e.to, kind: e.kind, label });
    edges.push({
      id,
      sources: [fieldPorts ? sourcePort : e.from],
      targets: [fieldPorts ? targetPort : e.to],
      labels: label ? [{ id: `${id}::label`, text: label, width: label.length * LABEL_CHAR_W + 8, height: LABEL_H }] : [],
    });
  }

  const children: ElkNode[] = view.nodes.map((n) => ({
    id: n.id,
    width: n.width,
    height: n.height,
    ports: fieldPorts ? (portsOf.get(n.id) ?? []) : [],
    layoutOptions: (fieldPorts ? { "elk.portConstraints": "FIXED_POS" } : {}) as LayoutOptions,
  }));

  elk ??= new ELK();
  const root: ElkNode = { id: "root", layoutOptions, children, edges };
  const laid: ElkNode = await elk.layout(root);

  const position = new Map((laid.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
  const pinned = options.pinned ?? {};
  const nodes = view.nodes.map((n) => {
    const at = pinned[n.id] ?? position.get(n.id) ?? { x: n.x, y: n.y };
    return { ...n, x: at.x, y: at.y };
  });

  const routes: RoutedEdge[] = [];
  for (const edge of laid.edges ?? []) {
    const m = meta.get(edge.id);
    if (!m) continue;
    const points: Point[] = [];
    for (const section of edge.sections ?? []) {
      points.push(section.startPoint, ...(section.bendPoints ?? []), section.endPoint);
    }
    const label = edge.labels?.[0];
    routes.push({
      id: edge.id,
      from: m.from,
      to: m.to,
      kind: m.kind,
      points: dedupe(points),
      label:
        label && m.label
          ? { text: m.label, x: label.x ?? 0, y: label.y ?? 0, width: label.width ?? 0, height: label.height ?? 0 }
          : undefined,
    });
  }

  return { ...view, nodes, routes, width: laid.width ?? 0, height: laid.height ?? 0 };
}

/**
 * The row a line to `target` leaves `source` from: the first listed field whose type
 * is `target`, or the "+N more" row when that field is among the ones not listed.
 */
export function fieldRow(source: SchemaNode, target: string): number | undefined {
  const { fields, more } = fieldPreview(source);
  const row = fields.findIndex((f) => referencedName(f.type) === target);
  if (row !== -1) return row;
  if (more > 0 && source.fields.some((f) => referencedName(f.type) === target)) return fields.length;
  return undefined;
}

function dedupe(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y);
}
