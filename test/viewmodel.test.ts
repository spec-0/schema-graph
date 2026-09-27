import { describe, expect, it } from "vitest";
import { buildSchemaGraph } from "../src/graph.js";
import {
  computeView,
  defaultFocus,
  visibleSchemaIds,
  widthForLabel,
  DEFAULT_MAX_NEIGHBOURS,
} from "../src/viewmodel.js";

// A: hub referencing B and C; B references D; E is an island; one op uses A.
const SPEC = {
  openapi: "3.0.3",
  info: { title: "T", version: "1" },
  paths: {
    "/a": {
      get: {
        responses: {
          "200": {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/A" } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      A: {
        type: "object",
        properties: {
          b: { $ref: "#/components/schemas/B" },
          c: { $ref: "#/components/schemas/C" },
        },
      },
      B: { type: "object", properties: { d: { $ref: "#/components/schemas/D" } } },
      C: { type: "object", properties: { x: { type: "string" } } },
      D: { type: "object", properties: { y: { type: "string" } } },
      E: { type: "object", properties: { z: { type: "string" } } },
    },
  },
};

const graph = buildSchemaGraph(SPEC);

describe("defaultFocus", () => {
  it("lands on the most-connected schema", () => {
    expect(defaultFocus(graph)).toBe("A");
  });
});

describe("visibleSchemaIds — progressive disclosure", () => {
  it("shows the focus plus one hop initially", () => {
    const visible = visibleSchemaIds(graph, { expanded: new Set(["A"]) });
    expect([...visible].sort()).toEqual(["A", "B", "C"]);
  });

  it("expanding a neighbour reveals its own neighbours", () => {
    const visible = visibleSchemaIds(graph, { expanded: new Set(["A", "B"]) });
    expect([...visible].sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("islands stay hidden until everything is trivially small", () => {
    const visible = visibleSchemaIds(graph, { expanded: new Set(["A", "B"]) });
    expect(visible.has("E")).toBe(false);
  });

  it("no schemas → empty view without throwing", () => {
    const empty = buildSchemaGraph({ components: { schemas: {} } });
    expect(visibleSchemaIds(empty, { expanded: new Set() }).size).toBe(0);
  });
});

describe("computeView", () => {
  it("positions every visible node with non-overlapping dagre coordinates", () => {
    const view = computeView(graph, { expanded: new Set(["A"]) });
    expect(view.nodes.map((n) => n.id).sort()).toEqual(["A", "B", "C"]);
    for (const n of view.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    const positions = new Set(view.nodes.map((n) => `${n.x},${n.y}`));
    expect(positions.size).toBe(view.nodes.length);
  });

  it("only draws edges between visible nodes", () => {
    const view = computeView(graph, { expanded: new Set(["A"]) });
    // B→D exists in the graph but D is not visible yet.
    expect(view.edges.some((e) => e.to === "D")).toBe(false);
  });

  it("attaches operations only when toggled on, and only to visible schemas", () => {
    const off = computeView(graph, { expanded: new Set(["A"]) });
    expect(off.nodes.some((n) => n.data.kind === "operation")).toBe(false);

    const on = computeView(graph, { expanded: new Set(["A"]), showOperations: true });
    const opNode = on.nodes.find((n) => n.data.kind === "operation");
    expect(opNode?.id).toBe("GET /a");
    expect(on.edges.some((e) => e.kind === "uses" && e.from === "GET /a" && e.to === "A")).toBe(
      true,
    );
  });

  it("resolves and reports the focus", () => {
    const view = computeView(graph, { expanded: new Set() });
    expect(view.focus).toBe("A");
  });
});

describe("structureless schemas", () => {
  // Hand-written specs commonly name their primitives. Those names are useful in a
  // list but drawn as nodes they are a box containing a scalar.
  const ALIASES = {
    openapi: "3.0.3",
    info: { title: "T", version: "1" },
    paths: {},
    components: {
      schemas: {
        Ticket: {
          type: "object",
          properties: {
            id: { $ref: "#/components/schemas/TicketId" },
            holder: { $ref: "#/components/schemas/Person" },
          },
        },
        Person: { type: "object", properties: { name: { type: "string" } } },
        TicketId: { type: "string" },
        Email: { type: "string", format: "email" },
        Status: { type: "string", enum: ["open", "closed"] },
      },
    },
  };

  it("flags schemas with no fields and no references as simple", () => {
    const graph = buildSchemaGraph(ALIASES);
    const simple = graph.schemas.filter((s) => s.simple).map((s) => s.name);
    expect(simple.sort()).toEqual(["Email", "Status", "TicketId"]);
  });

  it("does not flag a schema that has fields", () => {
    const graph = buildSchemaGraph(ALIASES);
    expect(graph.schemas.find((s) => s.name === "Person")?.simple).toBe(false);
    expect(graph.schemas.find((s) => s.name === "Ticket")?.simple).toBe(false);
  });

  it("hides simple schemas from the canvas by default", () => {
    const graph = buildSchemaGraph(ALIASES);
    const visible = visibleSchemaIds(graph, { focus: "Ticket", expanded: new Set(["Ticket"]) });
    expect(visible.has("Person")).toBe(true);
    expect(visible.has("TicketId")).toBe(false);
  });

  it("draws them when asked", () => {
    const graph = buildSchemaGraph(ALIASES);
    const visible = visibleSchemaIds(graph, {
      focus: "Ticket",
      expanded: new Set(["Ticket"]),
      showSimple: true,
    });
    expect(visible.has("TicketId")).toBe(true);
  });

  it("still draws a simple schema the user focused explicitly", () => {
    // Selecting one by name from a sidebar shouldn't produce an empty canvas.
    const graph = buildSchemaGraph(ALIASES);
    const visible = visibleSchemaIds(graph, { focus: "TicketId", expanded: new Set(["TicketId"]) });
    expect(visible.has("TicketId")).toBe(true);
  });
});

// ── Legibility on large specs (mailgun: 293 schemas, 57-character names) ──────────────────

describe("large-spec legibility", () => {
  /** A hub with `n` neighbours — the shape that turns one expansion into a wall. */
  function hub(n: number) {
    const schemas: Record<string, unknown> = {
      Hub: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: n }, (_, i) => [`f${i}`, { $ref: `#/components/schemas/Leaf${i}` }]),
        ),
      },
    };
    for (let i = 0; i < n; i++) {
      schemas[`Leaf${i}`] = { type: "object", properties: { id: { type: "string" }, x: { type: "object" } } };
    }
    return buildSchemaGraph({ components: { schemas } });
  }

  it("caps the neighbours revealed per hop instead of dumping all of them", () => {
    const view = computeView(hub(40), { focus: "Hub", expanded: new Set(["Hub"]) });
    // Hub + the cap, not Hub + 40.
    expect(view.nodes.length).toBeLessThanOrEqual(DEFAULT_MAX_NEIGHBOURS + 1);
  });

  it("reports what it withheld rather than truncating silently", () => {
    const view = computeView(hub(40), { focus: "Hub", expanded: new Set(["Hub"]) });
    expect(view.truncated).toEqual([
      { nodeId: "Hub", shown: DEFAULT_MAX_NEIGHBOURS, total: 40 },
    ]);
  });

  it("raising the cap reveals more, so the limit is a default and not a ceiling", () => {
    const view = computeView(hub(40), {
      focus: "Hub",
      expanded: new Set(["Hub"]),
      maxNeighbours: 40,
    });
    expect(view.nodes.length).toBe(41);
    expect(view.truncated).toEqual([]);
  });

  it("sizes boxes to their label so long generated names stay readable", () => {
    const short = widthForLabel("Pet");
    const long = widthForLabel("github.com-mailgun-scaffold-httpapi-paging-PagingResponse");
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(420); // bounded, or one node owns the canvas
  });

  it("honours dragged positions so hand-arranging the canvas survives expansion", () => {
    const graph = hub(3);
    const pinned = { Hub: { x: 1234, y: 567 } };
    const view = computeView(graph, { focus: "Hub", expanded: new Set(["Hub"]), pinned });
    const hubNode = view.nodes.find((n) => n.id === "Hub")!;
    expect({ x: hubNode.x, y: hubNode.y }).toEqual(pinned.Hub);
  });
});
