import { describe, expect, it } from "vitest";
import { layoutTypedGraph, positionsOf, type TypedGraph } from "../src/typed.js";

const GRAPH: TypedGraph = {
  nodes: [
    { id: "team:a", kind: "TEAM", label: "Orders" },
    { id: "api:1", kind: "API", label: "orders-api", counts: { schemas: 12 } },
    { id: "api:2", kind: "API", label: "billing-api" },
  ],
  edges: [
    { from: "team:a", to: "api:1", kind: "OWNS" },
    { from: "team:a", to: "api:2", kind: "OWNS" },
  ],
};

describe("layoutTypedGraph", () => {
  it("positions every node with finite, distinct coordinates", () => {
    const view = layoutTypedGraph(GRAPH);
    expect(view.nodes).toHaveLength(3);
    for (const node of view.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
    expect(new Set(view.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(3);
  });

  it("is deterministic regardless of the order nodes arrive in", () => {
    const shuffled: TypedGraph = {
      nodes: [...GRAPH.nodes].reverse(),
      edges: [...GRAPH.edges].reverse(),
    };
    expect(positionsOf(layoutTypedGraph(shuffled))).toEqual(
      positionsOf(layoutTypedGraph(GRAPH)),
    );
  });

  it("drops edges whose endpoints are not on screen rather than dangling", () => {
    const view = layoutTypedGraph({
      nodes: [{ id: "api:1", kind: "API", label: "orders-api" }],
      edges: [{ from: "team:a", to: "api:1", kind: "OWNS" }],
    });
    expect(view.edges).toHaveLength(0);
  });

  // Stability: toggling a node type must not reshuffle what the
  // user is already looking at.
  it("keeps surviving nodes exactly where they were when the graph changes", () => {
    const first = layoutTypedGraph(GRAPH);
    const previous = positionsOf(first);

    const withMore = layoutTypedGraph(
      {
        nodes: [
          ...GRAPH.nodes,
          { id: "schema:1", kind: "SCHEMA", label: "Order" },
          { id: "schema:2", kind: "SCHEMA", label: "Money" },
        ],
        edges: [
          ...GRAPH.edges,
          { from: "api:1", to: "schema:1", kind: "HAS_SCHEMA" },
          { from: "api:1", to: "schema:2", kind: "HAS_SCHEMA" },
        ],
      },
      { previous },
    );

    for (const id of ["team:a", "api:1", "api:2"]) {
      const before = previous[id]!;
      const after = withMore.nodes.find((n) => n.id === id)!;
      expect({ x: after.x, y: after.y }).toEqual(before);
    }
    // …and the new nodes are actually placed — distinct positions, not stacked on each other.
    // (In LR layout siblings share an x and differ in y, so compare the pair, not one axis.)
    const added = withMore.nodes.filter((n) => n.kind === "SCHEMA");
    expect(added).toHaveLength(2);
    expect(new Set(added.map((n) => `${n.x},${n.y}`)).size).toBe(2);
  });

  it("removing nodes leaves the survivors untouched too", () => {
    const previous = positionsOf(layoutTypedGraph(GRAPH));
    const fewer = layoutTypedGraph(
      { nodes: GRAPH.nodes.filter((n) => n.id !== "api:2"), edges: [] },
      { previous },
    );
    for (const node of fewer.nodes) {
      expect({ x: node.x, y: node.y }).toEqual(previous[node.id]!);
    }
  });

  it("honours per-kind sizing", () => {
    const view = layoutTypedGraph(GRAPH, {
      sizeFor: (n) => (n.kind === "TEAM" ? { width: 300, height: 90 } : { width: 180, height: 56 }),
    });
    expect(view.nodes.find((n) => n.id === "team:a")!.width).toBe(300);
    expect(view.nodes.find((n) => n.id === "api:1")!.width).toBe(180);
  });
});
