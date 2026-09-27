"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { buildSchemaGraph } from "../graph.js";
import type { OperationNode, SchemaGraph, SchemaNode } from "../types.js";
import { computeView, defaultFocus } from "../viewmodel.js";

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
}

type FlowNodeData = {
  entity: SchemaNode | OperationNode;
  selected: boolean;
  expanded: boolean;
  /** Laid-out width — long generated names are unreadable in a fixed box. */
  width?: number;
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

function SchemaFlowNode({ data }: NodeProps & { data: FlowNodeData }) {
  const entity = data.entity;
  const isSchema = entity.kind === "schema";
  return (
    <div
      style={{
        width: (data as { width?: number }).width ?? (isSchema ? 220 : 240),
        borderRadius: 10,
        border: `1.5px solid ${data.selected ? palette.schemaSelected : palette.border}`,
        background: isSchema ? palette.schemaBg : palette.opBg,
        boxShadow: data.selected ? `0 0 0 3px ${palette.ring}` : "0 1px 2px #0000000a",
        padding: "10px 12px",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        cursor: "pointer",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      {isSchema ? (
        <>
          <div
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 13,
              fontWeight: 600,
              color: palette.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {(entity as SchemaNode).name}
            {(entity as SchemaNode).cyclic ? " ↺" : ""}
          </div>
          <div style={{ fontSize: 11, color: palette.muted, marginTop: 4 }}>
            {(entity as SchemaNode).fields.length} fields
            {(entity as SchemaNode).referencedBy.length > 0
              ? ` · used by ${(entity as SchemaNode).referencedBy.length}`
              : ""}
            {!data.expanded &&
            (entity as SchemaNode).references.length + (entity as SchemaNode).referencedBy.length >
              0
              ? " · click to expand"
              : ""}
          </div>
        </>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes: NodeTypes = { entity: SchemaFlowNode as NodeTypes[string] };

export function SchemaGraphView({
  spec,
  graph: prebuilt,
  initialSchema,
  showOperations: initialShowOperations = false,
  showSimple: initialShowSimple = false,
  height = "70vh",
  onSelectSchema,
  hidePanel = false,
}: SchemaGraphViewProps) {
  const graph = useMemo(() => {
    if (prebuilt) return prebuilt;
    if (spec === undefined) throw new Error("SchemaGraphView needs `spec` or `graph`");
    return buildSchemaGraph(spec);
  }, [prebuilt, spec]);

  const focus = initialSchema ?? defaultFocus(graph);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(focus ? [focus] : []));
  const [selected, setSelected] = useState<string | undefined>(focus);
  const [showOperations, setShowOperations] = useState(initialShowOperations);
  const [showSimple, setShowSimple] = useState(initialShowSimple);
  const simpleCount = graph.schemas.filter((s) => s.simple).length;

  // Positions the user dragged. Layout defers to these, so arranging the canvas by hand
  // survives expanding, collapsing and toggling.
  const [pinned, setPinned] = useState<Record<string, { x: number; y: number }>>({});

  const view = useMemo(
    () => computeView(graph, { focus, expanded, showOperations, showSimple, pinned }),
    [graph, focus, expanded, showOperations, showSimple, pinned],
  );

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
        position: { x: n.x, y: n.y },
        width: n.width,
        style: adjacent && !adjacent.has(n.id) ? { opacity: 0.25 } : undefined,
        data: {
          entity: n.data,
          selected: n.id === selected,
          expanded: expanded.has(n.id),
          width: n.width,
        },
      })),
    );
  }, [view, selected, expanded, adjacent]);

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
  const flowEdges: Edge[] = view.edges.map((e) => {
    const near = !adjacent || (adjacent.has(e.from) && adjacent.has(e.to));
    return {
      id: `${e.kind}:${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      animated: e.kind === "uses" && near,
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
          onNodeClick={onNodeClick}
          onNodesChange={onNodesChange}
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
