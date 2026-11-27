"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { buildSchemaGraph } from "../graph.js";
import type { OperationNode, SchemaGraph, SchemaNode } from "../types.js";
import {
  computeView,
  defaultFocus,
  edgeRoute,
  fieldPreview,
  NODE_GEOMETRY,
  OP_H,
  roundedPath,
  referenceLabel,
  referencedName,
  type EdgeRoute,
} from "../viewmodel.js";
import type { RoutedView } from "../elk.js";

/**
 * Interactive schema explorer for one OpenAPI document. Schema-centric with an
 * operations toggle; progressive disclosure — the canvas opens on the most-connected
 * schema and each click expands one hop of neighbours; the side panel shows the
 * selected schema's description and fields.
 *
 * Self-contained on purpose (inline styles, no CSS framework), so it can be embedded in
 * any app.
 */

export interface SchemaGraphViewProps {
  /** The OpenAPI document (YAML/JSON string or parsed object) — or a prebuilt graph. */
  spec?: string | object;
  graph?: SchemaGraph;
  /** Schema name to open on. Default: most-connected. */
  initialSchema?: string;
  /** Start with operation nodes shown. Default false. */
  showOperations?: boolean;
  /** Start with structureless schemas drawn (see `SchemaNode.simple`). Default false. */
  showSimple?: boolean;
  /**
   * Whether operation nodes are shown, for an embedder that draws its own
   * control. When set, it wins over the built-in toggle and over
   * `showOperations`; pair it with `onOperationsChange` to hear the toggle.
   */
  operations?: boolean;
  onOperationsChange?: (shown: boolean) => void;
  /** Whether structureless schemas are drawn, controlled; see `operations`. */
  simple?: boolean;
  onSimpleChange?: (shown: boolean) => void;
  /**
   * Draw the built-in toggles over the canvas. Default true. An embedder with
   * its own toolbar turns them off and passes `operations` and `simple`.
   */
  toolbar?: boolean;
  /** Canvas height. Default "70vh". */
  height?: string | number;
  /**
   * Called with the schema name when a schema node is clicked.
   *
   * Lets an embedder render its own detail view instead of the built-in panel —
   * an app with a richer schema renderer (merged `allOf`, resolved refs, usage)
   * shouldn't have to fight a 320px panel that can't match its theme.
   */
  onSelectSchema?: (name: string) => void;
  /** Hide the built-in detail panel, for embedders handling selection themselves. */
  hidePanel?: boolean;
  /**
   * Tidy up from an embedder's own toolbar. Each time this number changes, the boxes
   * the user moved go back to the layout and the canvas fits the graph again. The
   * built-in toolbar has its own Tidy up button.
   */
  tidyUp?: number;
  /** Called with whether any box has been moved, so an embedder can enable its Tidy up control. */
  onMovedChange?: (moved: boolean) => void;
  /**
   * How the graph is laid out. `"elk"` (the default) places the boxes and routes
   * every line around them with ELK, loaded when the graph first opens. `"dagre"` is
   * the earlier layout: boxes placed by dagre, lines drawn between them without
   * routing.
   */
  layout?: "elk" | "dagre";
}

type FlowNodeData = {
  entity: SchemaNode | OperationNode;
  selected: boolean;
  expanded: boolean;
  /** Laid-out width — long generated names are unreadable in a fixed box. */
  width?: number;
  /** Names of the document's schemas, so a field whose type is one can be marked. */
  schemaNames: ReadonlySet<string>;
};

/**
 * Theming.
 *
 * Values are CSS custom properties with the previous hardcoded colours as
 * fallbacks, so an embedder that defines nothing looks exactly as before while
 * one with a design system gets a canvas that matches it. Hardcoded white nodes
 * on a dark host read as broken, and no amount of surrounding polish fixes a
 * component that ignores the theme.
 *
 * Consumers set `--sg-*` on any ancestor. Mapping them onto an existing token
 * set is usually a single CSS rule.
 */
const palette = {
  border: "var(--sg-border, #d6d9e0)",
  schemaBg: "var(--sg-node-bg, #ffffff)",
  schemaSelected: "var(--sg-accent, #5B4CF5)",
  opBg: "var(--sg-op-bg, #f5f6fa)",
  text: "var(--sg-text, #1a1d27)",
  muted: "var(--sg-muted, #6b7180)",
  accent: "var(--sg-accent, #5B4CF5)",
  canvas: "var(--sg-canvas, transparent)",
  panelBg: "var(--sg-panel-bg, #fafbfc)",
  /** Behind an edge label, so the line doesn't run through the text. */
  canvasLabel: "var(--sg-label-bg, var(--sg-node-bg, #ffffff))",
  /** Selection ring — a token can't be alpha-composited, so it's its own property. */
  ring: "var(--sg-accent-ring, #5B4CF522)",
};

/**
 * The checkbox itself, styled defensively.
 *
 * A host application styles its own form controls, and `input { width: 100% }`
 * is a common rule. Inherited by a bare `<input
 * type="checkbox">` in here, it inflates the box to fill its pill and shoves the
 * label out the side, which is what this component looked like in one host: a wide
 * empty box with "Operations" spilling past it.
 *
 * A component that renders inside somebody else's stylesheet cannot rely on the
 * user-agent defaults surviving, so the dimensions are stated rather than
 * assumed. Everything here exists to neutralise a rule a host might set; none of
 * it is decoration.
 */
const checkboxStyle: CSSProperties = {
  width: 13,
  height: 13,
  minWidth: 13,
  flex: "none",
  margin: 0,
  padding: 0,
  borderRadius: 3,
  accentColor: palette.accent,
};

/**
 * The canvas toggles. One object rather than two copies of the same fifteen
 * declarations — they are the same control and drifting apart is the failure
 * mode this replaced.
 *
 * `whiteSpace: nowrap` is the point: without it a narrow canvas breaks
 * "Simple types (12)" across two lines and the pill grows taller than its
 * neighbour, which is what made the pair look misaligned.
 */
const toggleStyle: CSSProperties = {
  display: "inline-flex",
  gap: 6,
  alignItems: "center",
  whiteSpace: "nowrap",
  background: palette.panelBg,
  border: `1px solid ${palette.border}`,
  borderRadius: 8,
  padding: "4px 8px",
  fontSize: 12,
  lineHeight: 1.4,
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  color: palette.text,
  cursor: "pointer",
  userSelect: "none",
};

/** Lines attach to handles, but the handles aren't for the user to drag new lines from. */
const hiddenHandle: CSSProperties = { opacity: 0, pointerEvents: "none" };

/** Which handles a line uses for each route. */
const HANDLES: Record<EdgeRoute, { sourceHandle: string; targetHandle: string }> = {
  forward: { sourceHandle: "out", targetHandle: "in" },
  backward: { sourceHandle: "out-bottom", targetHandle: "in-bottom" },
  over: { sourceHandle: "out-top", targetHandle: "in-top" },
  self: { sourceHandle: "out", targetHandle: "in-top" },
};

/**
 * Lines run straight, horizontally and vertically, with rounded corners. The default
 * curve ignores the other boxes and wanders over them; straight runs between the
 * columns of the layout read as wiring and stay out of the boxes' way.
 */
const EDGE_PATH = { borderRadius: 10, offset: 20 };

function SchemaFlowNode({ data }: NodeProps & { data: FlowNodeData }) {
  const entity = data.entity;
  const isSchema = entity.kind === "schema";
  return (
    <div
      style={{
        width: (data as { width?: number }).width ?? (isSchema ? 220 : 240),
        borderRadius: 10,
        border: `${NODE_GEOMETRY.border}px solid ${data.selected ? palette.schemaSelected : palette.border}`,
        background: isSchema ? palette.schemaBg : palette.opBg,
        boxShadow: data.selected ? `0 0 0 3px ${palette.ring}` : "0 1px 2px #0000000a",
        padding: isSchema ? `${NODE_GEOMETRY.padTop}px 0 ${NODE_GEOMETRY.padBottom}px` : "0 12px",
        // An operation is one line, centred in the height layout gave it.
        ...(isSchema ? {} : { boxSizing: "border-box" as const, height: OP_H, display: "flex", alignItems: "center" }),
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        cursor: "pointer",
      }}
    >
      {/* Where lines attach; see edgeRoute for which pair a line uses. */}
      <Handle id="in" type="target" position={Position.Left} style={hiddenHandle} />
      <Handle id="in-bottom" type="target" position={Position.Bottom} style={hiddenHandle} />
      <Handle id="in-top" type="target" position={Position.Top} style={hiddenHandle} />
      {isSchema ? (
        <>
          <div
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 13,
              lineHeight: `${NODE_GEOMETRY.nameLine}px`,
              fontWeight: 600,
              color: palette.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              padding: `0 12px ${NODE_GEOMETRY.namePadBottom}px`,
              borderBottom: (entity as SchemaNode).fields.length ? `${NODE_GEOMETRY.rule}px solid ${palette.border}` : undefined,
            }}
          >
            {(entity as SchemaNode).name}
            {(entity as SchemaNode).cyclic ? " ↺" : ""}
          </div>
          <SchemaFields schema={entity as SchemaNode} schemaNames={data.schemaNames} />
        </>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0, width: "100%" }}>
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 10,
              fontWeight: 700,
              color: palette.accent,
            }}
          >
            {(entity as OperationNode).method}
          </span>
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 11,
              color: palette.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {(entity as OperationNode).path}
          </span>
        </div>
      )}
      <Handle id="out" type="source" position={Position.Right} style={hiddenHandle} />
      <Handle id="out-bottom" type="source" position={Position.Bottom} style={hiddenHandle} />
      <Handle id="out-top" type="source" position={Position.Top} style={hiddenHandle} />
    </div>
  );
}

/**
 * The first few fields of a schema, name on the left and type on the right.
 * A type that is another schema is drawn in the accent colour: those are the
 * fields the edges leave from.
 */
function SchemaFields({ schema, schemaNames }: { schema: SchemaNode; schemaNames: ReadonlySet<string> }) {
  const { fields, more } = fieldPreview(schema);
  if (!fields.length) {
    return (
      <div style={{ fontSize: 11, color: palette.muted, padding: "2px 12px 0" }}>
        {schema.simple ? "no fields" : "no fields of its own"}
      </div>
    );
  }
  const line: CSSProperties = {
    display: "flex",
    gap: 8,
    alignItems: "baseline",
    height: NODE_GEOMETRY.fieldLine,
    lineHeight: `${NODE_GEOMETRY.fieldLine}px`,
    padding: "0 12px",
    fontFamily: "ui-monospace, monospace",
    fontSize: 11,
    whiteSpace: "nowrap",
  };
  return (
    <div style={{ paddingTop: NODE_GEOMETRY.fieldsPadTop }}>
      {fields.map((field) => {
        const isRef = schemaNames.has(referencedName(field.type));
        return (
          <div key={field.name} style={line}>
            <span style={{ color: palette.text, overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
              {field.name}
              {field.required ? "" : "?"}
            </span>
            <span
              style={{
                marginLeft: "auto",
                color: isRef ? palette.accent : palette.muted,
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: "none",
                maxWidth: "60%",
              }}
            >
              {field.type}
            </span>
          </div>
        );
      })}
      {more > 0 && (
        <div style={{ ...line, fontFamily: "ui-sans-serif, system-ui, sans-serif", color: palette.muted }}>
          +{more} more
        </div>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = { entity: SchemaFlowNode as NodeTypes[string] };

type RoutedEdgeData = { points: { x: number; y: number }[]; labelAt?: { x: number; y: number } };

/** A line drawn along the route ELK worked out, with its label where ELK put it. */
function RoutedFlowEdge(props: EdgeProps) {
  const data = props.data as RoutedEdgeData;
  const points = data.points;
  const mid = points[Math.floor(points.length / 2)] ?? { x: props.sourceX, y: props.sourceY };
  return (
    <BaseEdge
      id={props.id}
      path={roundedPath(points)}
      style={props.style}
      label={props.label}
      labelX={data.labelAt?.x ?? mid.x}
      labelY={data.labelAt?.y ?? mid.y}
      labelStyle={props.labelStyle}
      labelShowBg={props.labelShowBg}
      labelBgStyle={props.labelBgStyle}
      labelBgPadding={props.labelBgPadding}
      labelBgBorderRadius={props.labelBgBorderRadius}
    />
  );
}

const edgeTypes: EdgeTypes = { routed: RoutedFlowEdge };

export function SchemaGraphView({
  spec,
  graph: prebuilt,
  initialSchema,
  showOperations: initialShowOperations = false,
  showSimple: initialShowSimple = false,
  height = "70vh",
  onSelectSchema,
  hidePanel = false,
  operations,
  onOperationsChange,
  simple,
  onSimpleChange,
  toolbar = true,
  tidyUp,
  onMovedChange,
  layout = "elk",
}: SchemaGraphViewProps) {
  const graph = useMemo(() => {
    if (prebuilt) return prebuilt;
    if (spec === undefined) throw new Error("SchemaGraphView needs `spec` or `graph`");
    return buildSchemaGraph(spec);
  }, [prebuilt, spec]);

  const focus = initialSchema ?? defaultFocus(graph);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(focus ? [focus] : []));
  const [selected, setSelected] = useState<string | undefined>(focus);
  const [ownOperations, setOwnOperations] = useState(initialShowOperations);
  const [ownSimple, setOwnSimple] = useState(initialShowSimple);
  // Controlled when the embedder passes a value; the built-in toggle still reports changes.
  const showOperations = operations ?? ownOperations;
  const showSimple = simple ?? ownSimple;
  const setShowOperations = (shown: boolean) => {
    setOwnOperations(shown);
    onOperationsChange?.(shown);
  };
  const setShowSimple = (shown: boolean) => {
    setOwnSimple(shown);
    onSimpleChange?.(shown);
  };
  const schemaNames = useMemo(() => new Set(graph.schemas.map((s) => s.name)), [graph]);
  const simpleCount = graph.schemas.filter((s) => s.simple).length;

  // Positions the user dragged. Layout defers to these, so arranging the canvas by hand
  // survives expanding, collapsing and toggling.
  const [pinned, setPinned] = useState<Record<string, { x: number; y: number }>>({});
  const moved = Object.keys(pinned).length > 0;
  useEffect(() => {
    onMovedChange?.(moved);
  }, [moved, onMovedChange]);

  // Tidy up: forget the moves, so the layout places every box again, then fit the
  // canvas to the result once the nodes have their new positions.
  const flow = useRef<ReactFlowInstance | null>(null);
  const [fitPending, setFitPending] = useState(false);
  const tidy = useCallback(() => {
    setPinned({});
    setFitPending(true);
  }, []);
  const lastTidyUp = useRef(tidyUp);
  useEffect(() => {
    if (tidyUp === lastTidyUp.current) return;
    lastTidyUp.current = tidyUp;
    tidy();
  }, [tidyUp, tidy]);

  const view = useMemo(
    () => computeView(graph, { focus, expanded, showOperations, showSimple, pinned }),
    [graph, focus, expanded, showOperations, showSimple, pinned],
  );

  // ELK's layout of the same boxes, with every line routed. It runs asynchronously
  // and ELK itself is loaded on first use, so the dagre layout above stands in for
  // the moment before it arrives, and for good if ELK can't run.
  const [routed, setRouted] = useState<RoutedView | null>(null);
  useEffect(() => {
    if (layout !== "elk") {
      setRouted(null);
      return;
    }
    let live = true;
    import("../elk.js")
      .then(({ computeRoutedView, ELK_OPTIONS }) =>
        computeRoutedView(graph, { focus, expanded, showOperations, showSimple }, ELK_OPTIONS),
      )
      .then((result) => {
        if (!live) return;
        setRouted(result);
        // A new layout can move every box, so show the whole of it again.
        setFitPending(true);
      })
      .catch(() => {
        if (live) setRouted(null);
      });
    return () => {
      live = false;
    };
  }, [layout, graph, focus, expanded, showOperations, showSimple]);
  const routedAt = useMemo(() => new Map((routed?.nodes ?? []).map((n) => [n.id, { x: n.x, y: n.y }])), [routed]);
  const routes = useMemo(() => new Map((routed?.routes ?? []).map((r) => [r.id, r])), [routed]);

  // Neighbours of the selection, for focus+context dimming: on a busy canvas the point is to
  // read ONE neighbourhood, not to squint at all of them equally.
  const adjacent = useMemo(() => {
    if (!selected) return undefined;
    const near = new Set<string>([selected]);
    for (const e of view.edges) {
      if (e.from === selected) near.add(e.to);
      if (e.to === selected) near.add(e.from);
    }
    return near;
  }, [selected, view.edges]);

  const [flowNodes, setFlowNodes] = useState<Node<FlowNodeData>[]>([]);
  useEffect(() => {
    setFlowNodes(
      view.nodes.map((n) => ({
        id: n.id,
        type: "entity",
        position: pinned[n.id] ?? routedAt.get(n.id) ?? { x: n.x, y: n.y },
        width: n.width,
        style: adjacent && !adjacent.has(n.id) ? { opacity: 0.25 } : undefined,
        data: {
          entity: n.data,
          selected: n.id === selected,
          expanded: expanded.has(n.id),
          width: n.width,
          schemaNames,
        },
      })),
    );
  }, [view, selected, expanded, adjacent, schemaNames, pinned, routedAt]);

  useEffect(() => {
    if (!fitPending) return;
    setFitPending(false);
    // After React Flow has measured the moved nodes.
    requestAnimationFrame(() => flow.current?.fitView({ maxZoom: 1, padding: 0.2, duration: 300 }));
  }, [flowNodes, fitPending]);

  // Where each box is now, including while it's being dragged, so a line picks its
  // route from what's on screen.
  const boxes = useMemo(
    () => new Map(
        flowNodes.map((n) => [
          n.id,
          { x: n.position.x, y: n.position.y, width: n.width ?? n.data.width ?? 220, height: n.measured?.height },
        ]),
      ),
    [flowNodes],
  );

  // Without this handler React Flow treats the node array as fully controlled and silently
  // discards drags — the nodes look draggable and refuse to move.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setFlowNodes((prev) => applyNodeChanges(changes, prev) as Node<FlowNodeData>[]);
    for (const change of changes) {
      if (change.type === "position" && change.dragging === false && change.position) {
        const { id, position } = change;
        setPinned((prev) => ({ ...prev, [id]: { x: position.x, y: position.y } }));
      }
    }
  }, []);
  const byId = useMemo(() => new Map(graph.schemas.map((s) => [s.id, s])), [graph]);
  const flowEdges: Edge[] = view.edges.map((e) => {
    const near = !adjacent || (adjacent.has(e.from) && adjacent.has(e.to));
    const from = e.kind === "references" ? byId.get(e.from) : undefined;
    const to = byId.get(e.to);
    // Only edges in the selected neighbourhood are labelled: faded edges' labels
    // pile up on each other and read as noise.
    // Two schemas that refer to each other get two edges along the same path, and
    // their labels land on the same spot. Only one is labelled: the one leaving the
    // selected schema, or with nothing selected, the first by id.
    const reverse = e.kind === "references" && view.edges.some((r) => r.kind === "references" && r.from === e.to && r.to === e.from);
    const labelThis = !reverse || (selected ? e.from === selected : e.from < e.to);
    const label = near && labelThis && from && to ? referenceLabel(from, to.name) : undefined;
    const id = `${e.kind}:${e.from}->${e.to}`;
    // ELK's route holds while both ends are where ELK put them. Once the user moves
    // either box, the line falls back to a step line between the boxes until Tidy up.
    const elk = routes.get(id);
    const inPlace = (node: string) => {
      const at = routedAt.get(node);
      const now = boxes.get(node);
      return Boolean(at && now && Math.abs(at.x - now.x) < 0.5 && Math.abs(at.y - now.y) < 0.5);
    };
    const shape =
      elk && inPlace(e.from) && inPlace(e.to)
        ? {
            type: "routed",
            data: {
              points: elk.points,
              labelAt: elk.label && { x: elk.label.x + elk.label.width / 2, y: elk.label.y + elk.label.height / 2 },
            } satisfies RoutedEdgeData,
          }
        : {
            ...HANDLES[edgeRoute(e.from, e.to, boxes.get(e.from), boxes.get(e.to))],
            type: "smoothstep",
            pathOptions: EDGE_PATH,
          };
    return {
      id,
      source: e.from,
      target: e.to,
      ...shape,
      animated: e.kind === "uses" && near,
      // The field that refers, on references edges: the line says why the boxes are joined.
      label,
      labelStyle: { fontFamily: "ui-monospace, monospace", fontSize: 10, fill: palette.muted },
      labelBgStyle: { fill: palette.canvasLabel },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      style: {
        stroke: e.kind === "uses" ? palette.muted : palette.accent,
        strokeWidth: near ? 1.5 : 1,
        opacity: near ? 1 : 0.15,
      },
    };
  });

  const onNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      setSelected(node.id);
      const entity = graph.schemas.find((s) => s.id === node.id);
      if (entity) {
        setExpanded((prev) => new Set([...prev, node.id]));
        onSelectSchema?.(entity.name);
      }
    },
    [graph, onSelectSchema],
  );

  const selectedSchema = graph.schemas.find((s) => s.id === selected);

  return (
    <div style={{ display: "flex", height, border: `1px solid ${palette.border}`, borderRadius: 12, overflow: "hidden" }}>
      <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onNodesChange={onNodesChange}
          onInit={(instance) => {
            flow.current = instance as unknown as ReactFlowInstance;
          }}
          fitView
          // Fitting 40 boxes to the viewport zooms past the point where labels mean anything;
          // cap it and let the user pan instead.
          fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {view.truncated.length > 0 && (
          <div
            style={{
              position: "absolute",
              bottom: 10,
              left: 10,
              maxWidth: 420,
              background: palette.panelBg,
              border: `1px solid ${palette.border}`,
              borderRadius: 8,
              padding: "6px 9px",
              fontFamily: "ui-sans-serif, system-ui, sans-serif",
              fontSize: 11,
              color: palette.muted,
              zIndex: 5,
            }}
          >
            {view.truncated.map((t) => (
              <div key={t.nodeId}>
                Showing {t.shown} of {t.total} linked schemas for{" "}
                <strong>{t.nodeId}</strong> — click a neighbour to explore further.
              </div>
            ))}
          </div>
        )}
        {/*
          One positioned container, not one per toggle.
          
          Each toggle used to place itself absolutely at a hand-measured offset —
          the second sat at `top: 46` because that was roughly where the first
          one ended. Any change to font size, padding or a longer label moved the
          first without moving the second, so they drifted apart or overlapped,
          and a narrow canvas pushed them over the edge of it. Laying them out in
          a flow container removes the guess: they stack, they stay aligned, and
          the group wraps inside the canvas instead of spilling out of it.
        */}
        {toolbar && (
        <div
          className="sg-toolbar"
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            // Leave room for the zoom controls in the opposite corner rather
            // than letting a long label run underneath them.
            maxWidth: "calc(100% - 20px)",
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            alignItems: "flex-start",
            zIndex: 5,
          }}
        >
          <label style={toggleStyle}>
            <input
              type="checkbox"
              checked={showOperations}
              onChange={(e) => setShowOperations(e.target.checked)}
              style={checkboxStyle}
            />
            Operations
          </label>
          <button
            type="button"
            onClick={tidy}
            disabled={!moved}
            title={moved ? "Put the boxes you moved back and lay the graph out again" : "Nothing has been moved"}
            style={{ ...toggleStyle, opacity: moved ? 1 : 0.5, cursor: moved ? "pointer" : "default" }}
          >
            Tidy up
          </button>
          {simpleCount > 0 && (
            <label
              style={toggleStyle}
              title="Named primitives, enums and scalar arrays — no structure to expand"
            >
              <input
                type="checkbox"
                checked={showSimple}
                onChange={(e) => setShowSimple(e.target.checked)}
                style={checkboxStyle}
              />
              Simple types ({simpleCount})
            </label>
          )}
        </div>
        )}
      </div>

      {selectedSchema && !hidePanel && (
        <aside
          style={{
            width: 320,
            borderLeft: `1px solid ${palette.border}`,
            padding: 16,
            overflowY: "auto",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            background: palette.panelBg,
          }}
        >
          <h3
            style={{
              margin: 0,
              fontFamily: "ui-monospace, monospace",
              fontSize: 15,
              color: palette.text,
            }}
          >
            {selectedSchema.name}
          </h3>
          {selectedSchema.description && (
            <p style={{ fontSize: 13, color: palette.muted, lineHeight: 1.5 }}>
              {selectedSchema.description}
            </p>
          )}
          <table style={{ width: "100%", marginTop: 12, borderCollapse: "collapse", fontSize: 12 }}>
            <tbody>
              {selectedSchema.fields.map((f) => (
                <tr key={f.name} style={{ borderTop: `1px solid ${palette.border}` }}>
                  <td
                    style={{
                      padding: "6px 8px 6px 0",
                      fontFamily: "ui-monospace, monospace",
                      color: palette.text,
                      verticalAlign: "top",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {f.name}
                    {f.required ? " *" : ""}
                  </td>
                  <td
                    style={{
                      padding: "6px 0",
                      fontFamily: "ui-monospace, monospace",
                      color: palette.accent,
                      verticalAlign: "top",
                    }}
                  >
                    {f.type}
                  </td>
                </tr>
              ))}
              {selectedSchema.fields.length === 0 && (
                <tr>
                  <td style={{ padding: "6px 0", color: palette.muted }}>No object properties.</td>
                </tr>
              )}
            </tbody>
          </table>
          {selectedSchema.referencedBy.length > 0 && (
            <p style={{ fontSize: 12, color: palette.muted, marginTop: 12 }}>
              Referenced by: {selectedSchema.referencedBy.join(", ")}
            </p>
          )}
        </aside>
      )}
    </div>
  );
}
