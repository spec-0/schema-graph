"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  layoutTypedGraph,
  positionsOf,
  type TypedGraph,
  type TypedNode,
} from "../typed.js";

/**
 * Renders a typed graph whose contents someone else decided — the producer (a server applying
 * level-of-detail, say) chose what belongs on screen; this component lays it out, styles it by
 * kind, and reports clicks.
 *
 * Layout is stable across renders: nodes that survive a change keep their exact positions, so
 * toggling a node type adds and removes boxes without reshuffling what the user was reading.
 *
 * Self-contained styling (no CSS framework) so the component can be embedded in any app.
 */

export interface OrgGraphViewProps {
  graph: TypedGraph;
  /** Per-kind accent colour. Unknown kinds fall back to a neutral. */
  colorFor?: (kind: string) => string;
  onNodeClick?: (node: TypedNode) => void;
  /** Called when a node with an href is activated for navigation (double-click or the link). */
  onNavigate?: (node: TypedNode) => void;
  height?: string | number;
  /** Rendered over the canvas — caveats the producer wants stated, e.g. missing-data notes. */
  notes?: string[];
}

type FlowData = { entity: TypedNode; accent: string; selected: boolean };

const NEUTRAL = "#6b7180";

const DEFAULT_COLORS: Record<string, string> = {
  TEAM: "#5B4CF5",
  SERVICE: "#0EA5E9",
  API: "#10B981",
  OPERATION: "#F59E0B",
  SCHEMA: "#8B5CF6",
  DOMAIN: "#EC4899",
};

function EntityNode({ data }: NodeProps & { data: FlowData }) {
  const { entity, accent, selected } = data;
  const counts = Object.entries(entity.counts ?? {}).filter(([, v]) => v > 0);
  return (
    <div
      style={{
        minWidth: 180,
        borderRadius: 10,
        border: `1.5px solid ${selected ? accent : "#d6d9e0"}`,
        borderLeft: `4px solid ${accent}`,
        background: "#ffffff",
        boxShadow: selected ? `0 0 0 3px ${accent}22` : "0 1px 2px #0000000a",
        padding: "8px 12px",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        cursor: "pointer",
      }}
      title={entity.href ? "Double-click to open" : undefined}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div
        style={{
          fontSize: 9,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: accent,
          fontWeight: 600,
        }}
      >
        {entity.kind}
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "#1a1d27",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 220,
        }}
      >
        {entity.label}
      </div>
      {entity.sublabel && (
        <div style={{ fontSize: 11, color: NEUTRAL, marginTop: 1 }}>{entity.sublabel}</div>
      )}
      {counts.length > 0 && (
        <div style={{ fontSize: 11, color: NEUTRAL, marginTop: 3 }}>
          {counts.map(([k, v]) => `${v} ${k}`).join(" · ")}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes: NodeTypes = { entity: EntityNode as unknown as NodeTypes[string] };

export function OrgGraphView({
  graph,
  colorFor,
  onNodeClick,
  onNavigate,
  height = "72vh",
  notes = [],
}: OrgGraphViewProps) {
  const [selected, setSelected] = useState<string | undefined>();
  // Positions survive re-renders so a graph change never reshuffles what's on screen.
  const positions = useRef<Record<string, { x: number; y: number }>>({});

  const accent = useCallback(
    (kind: string) => colorFor?.(kind) ?? DEFAULT_COLORS[kind] ?? NEUTRAL,
    [colorFor],
  );

  const view = useMemo(() => {
    const laid = layoutTypedGraph(graph, { previous: positions.current });
    positions.current = positionsOf(laid);
    return laid;
  }, [graph]);

  const [nodes, setNodes] = useState<Node[]>([]);
  useEffect(() => {
    setNodes(
      view.nodes.map((n) => ({
        id: n.id,
        type: "entity",
        position: { x: n.x - n.width / 2, y: n.y - n.height / 2 },
        data: { entity: n, accent: accent(n.kind), selected: n.id === selected } as FlowData,
      })),
    );
  }, [view, selected, accent]);

  // Without this handler React Flow discards drags silently — nodes look draggable and never
  // move. Dropped positions are remembered so the next layout defers to them.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((prev) => applyNodeChanges(changes, prev));
    for (const change of changes) {
      if (change.type === "position" && change.dragging === false && change.position) {
        positions.current[change.id] = {
          x: change.position.x,
          y: change.position.y,
        };
      }
    }
  }, []);

  const edges: Edge[] = useMemo(
    () =>
      view.edges.map((e, i) => ({
        id: `${e.from}->${e.to}:${e.kind}:${i}`,
        source: e.from,
        target: e.to,
        label: e.count && e.count > 1 ? String(e.count) : undefined,
        animated: e.kind === "CONSUMES" || e.kind === "CONSUMES_ROLLUP",
        style: {
          stroke: e.kind === "SAME_SHAPE_AS" ? "#8B5CF6" : "#c7cbd4",
          strokeDasharray: e.kind === "SAME_SHAPE_AS" ? "4 3" : undefined,
        },
      })),
    [view],
  );

  const byId = useMemo(() => new Map(view.nodes.map((n) => [n.id, n])), [view]);

  return (
    <div style={{ position: "relative", height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: false }}
        onNodeClick={(_, node) => {
          setSelected(node.id);
          const entity = byId.get(node.id);
          if (entity) onNodeClick?.(entity);
        }}
        onNodeDoubleClick={(_, node) => {
          const entity = byId.get(node.id);
          if (entity?.href) onNavigate?.(entity);
        }}
      >
        <Background />
        <Controls />
      </ReactFlow>

      {notes.length > 0 && (
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            maxWidth: 460,
            background: "#ffffffee",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: "8px 10px",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            fontSize: 11,
            color: NEUTRAL,
            lineHeight: 1.45,
          }}
        >
          {notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      )}
    </div>
  );
}
