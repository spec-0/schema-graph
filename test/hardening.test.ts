/**
 * Hostile-input tests.
 *
 * This library reads OpenAPI documents that somebody else wrote. In this repo
 * alone that means specs uploaded to the dashboard and specs opened in the
 * desktop app; published, it means anyone's. So the interesting question is not
 * "does it graph a good spec" — the other suites cover that — but "what does a
 * bad one do to the process".
 *
 * Every case here failed before the fix it guards. They are written as
 * termination and invariant tests rather than output assertions, because the
 * failure mode of each was a hang, a crash, or a graph that lied about itself.
 */

import { describe, expect, it } from "vitest";
import { buildSchemaGraph, parseSpec } from "../src/index.js";

const doc = (schemas: Record<string, unknown>, paths: Record<string, unknown> = {}) => ({
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  paths,
  components: { schemas },
});

/** The invariant a renderer depends on: no edge points at a node that isn't there. */
const danglingEdges = (graph: ReturnType<typeof buildSchemaGraph>) => {
  const ids = new Set([...graph.schemas.map((s) => s.id), ...graph.operations.map((o) => o.id)]);
  return graph.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
};

describe("cycles in the document object", () => {
  // Nine lines of valid YAML. The alias points at an ancestor anchor, so
  // js-yaml hands back a genuinely circular object — and the ref walker used to
  // recurse into it until the stack gave out.
  it("survives a YAML alias that points at its own ancestor", () => {
    const yaml = [
      "openapi: 3.0.0",
      "info: {}",
      "paths: {}",
      "components:",
      "  schemas:",
      "    A: &a",
      "      type: object",
      "      properties:",
      "        loop: *a",
    ].join("\n");

    const graph = buildSchemaGraph(yaml);
    expect(graph.schemas).toHaveLength(1);
    expect(danglingEdges(graph)).toEqual([]);
  });

  // Callers may pass an already-parsed object, and nothing stops that object
  // from being circular.
  it("survives a circular object handed in directly", () => {
    const schema: Record<string, unknown> = { type: "object", properties: {} };
    (schema.properties as Record<string, unknown>).self = schema;

    const graph = buildSchemaGraph(doc({ A: schema }));
    expect(graph.schemas).toHaveLength(1);
  });

  it("survives two schemas that reference each other through the object graph", () => {
    const a: Record<string, unknown> = { type: "object", properties: {} };
    const b: Record<string, unknown> = { type: "object", properties: { a } };
    (a.properties as Record<string, unknown>).b = b;

    expect(() => buildSchemaGraph(doc({ A: a, B: b }))).not.toThrow();
  });
});

describe("aliased fan-out (the billion-laughs shape)", () => {
  // js-yaml resolves an alias to *the same object*, not a copy, so an aliased
  // fan-out is a DAG whose path count doubles per level. Walking it by path was
  // exponential: 24 levels took 1.6s, and 60 would not have finished this
  // decade. The seen-set is the entire defence, so the bound is deliberately
  // generous — it is separating "instant" from "never", not measuring speed.
  it("does not blow up on 60 levels of aliasing", () => {
    let yaml = "openapi: 3.0.0\ninfo: {}\npaths: {}\nx0: &x0 { a: 1, b: 2 }\n";
    for (let i = 1; i <= 60; i += 1) {
      yaml += `x${i}: &x${i} { a: *x${i - 1}, b: *x${i - 1} }\n`;
    }
    yaml += "components:\n  schemas:\n    A:\n      properties:\n        p: *x60\n";

    const started = Date.now();
    const graph = buildSchemaGraph(yaml);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(graph.schemas).toHaveLength(1);
  });

  it("still finds a ref that only appears inside a shared subtree", () => {
    const yaml = [
      "openapi: 3.0.0",
      "info: {}",
      "paths: {}",
      "shared: &s",
      "  $ref: '#/components/schemas/B'",
      "components:",
      "  schemas:",
      "    A:",
      "      properties:",
      "        one: *s",
      "        two: *s",
      "    B:",
      "      type: string",
    ].join("\n");

    const graph = buildSchemaGraph(yaml);
    const a = graph.schemas.find((s) => s.id === "A");
    expect(a?.references).toEqual(["B"]);
  });
});

describe("depth", () => {
  it("handles a document nested 200,000 deep without exhausting the stack", () => {
    let node: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 200_000; i += 1) node = { type: "object", properties: { n: node } };

    expect(() => buildSchemaGraph(doc({ A: node }))).not.toThrow();
  });

  // The recursive cycle-finder overflowed at about five thousand links. Stripe
  // defines roughly fourteen hundred schemas, so that ceiling was inside the
  // range of documents this is expected to read.
  it("handles a reference chain 200,000 long", () => {
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < 200_000; i += 1) {
      schemas[`S${i}`] = { properties: { next: { $ref: `#/components/schemas/S${i + 1}` } } };
    }

    const graph = buildSchemaGraph(doc(schemas));
    expect(graph.schemas).toHaveLength(200_000);
    expect(graph.schemas.filter((s) => s.cyclic)).toHaveLength(0);
  });

  it("still marks a genuine cycle, and only the nodes on it", () => {
    const graph = buildSchemaGraph(
      doc({
        A: { properties: { b: { $ref: "#/components/schemas/B" } } },
        B: { properties: { c: { $ref: "#/components/schemas/C" } } },
        C: { properties: { a: { $ref: "#/components/schemas/A" } } },
        // Points into the cycle without being on it.
        D: { properties: { a: { $ref: "#/components/schemas/A" } } },
      }),
    );
    expect(graph.schemas.filter((s) => s.cyclic).map((s) => s.id)).toEqual(["A", "B", "C"]);
  });
});

describe("names that exist on every object", () => {
  // `in` walks the prototype chain, so `"constructor" in schemas` is true for
  // any object. A ref to one of these produced an edge to a node that was never
  // in the node list.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "a $ref to %s creates no edge to a schema that does not exist",
    (name) => {
      const graph = buildSchemaGraph(
        doc({ A: { properties: { x: { $ref: `#/components/schemas/${name}` } } } }),
      );
      expect(danglingEdges(graph)).toEqual([]);
    },
  );

  it("graphs a schema genuinely named constructor", () => {
    const graph = buildSchemaGraph(
      doc({
        constructor: { type: "string" },
        A: { properties: { x: { $ref: "#/components/schemas/constructor" } } },
      }),
    );
    expect(graph.schemas.map((s) => s.id).sort()).toEqual(["A", "constructor"]);
    expect(danglingEdges(graph)).toEqual([]);
  });

  it("does not pollute Object.prototype through a __proto__ key", () => {
    const parsed = parseSpec('{"components":{"schemas":{"__proto__":{"polluted":true}}}}');
    expect(() => buildSchemaGraph(parsed)).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

describe("malformed documents are rejected, not mishandled", () => {
  it.each([
    ["a bare scalar", "just a string"],
    ["a sequence at the root", "- a\n- b"],
    ["null", "null"],
  ])("%s is a clear error", (_label, input) => {
    expect(() => parseSpec(input)).toThrow(/must be an object/);
  });

  it("unparseable YAML surfaces the parser's own error", () => {
    expect(() => parseSpec("key: [unclosed\n  other: 1")).toThrow();
  });

  it.each([
    ["no components", { openapi: "3.0.0", info: {}, paths: {} }],
    ["schemas as an array", { components: { schemas: [] } }],
    ["schemas as a string", { components: { schemas: "nope" } }],
    ["paths as a string", { paths: "nope", components: { schemas: {} } }],
    ["a null schema", { components: { schemas: { A: null } } }],
    ["an empty object", {}],
  ])("%s yields an empty graph rather than throwing", (_label, input) => {
    const graph = buildSchemaGraph(input);
    expect(graph.edges).toEqual([]);
    expect(danglingEdges(graph)).toEqual([]);
  });

  it("ignores a $ref that points outside components/schemas", () => {
    const graph = buildSchemaGraph(
      doc({
        A: {
          properties: {
            x: { $ref: "#/components/responses/Nope" },
            y: { $ref: "https://evil.example/schema.json" },
            z: { $ref: "../../../etc/passwd" },
          },
        },
      }),
    );
    expect(graph.schemas[0]?.references).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});

describe("the graph describes itself accurately", () => {
  const spec = doc(
    {
      Order: {
        properties: { customer: { $ref: "#/components/schemas/Customer" } },
        required: ["customer"],
      },
      Customer: { properties: { name: { type: "string" } } },
      Orphan: { type: "string" },
    },
    {
      "/orders": {
        get: { summary: "List", responses: { 200: { $ref: "#/components/schemas/Order" } } },
        // Not an HTTP method — must not become an operation node.
        parameters: [{ $ref: "#/components/schemas/Customer" }],
      },
    },
  );

  it("never emits an edge to a node it did not emit", () => {
    expect(danglingEdges(buildSchemaGraph(spec))).toEqual([]);
  });

  it("only treats real HTTP methods as operations", () => {
    const graph = buildSchemaGraph(spec);
    expect(graph.operations.map((o) => o.id)).toEqual(["GET /orders"]);
  });

  it("is deterministic — the same document twice gives the same graph", () => {
    const once = buildSchemaGraph(spec);
    const twice = buildSchemaGraph(spec);
    expect(JSON.stringify({ ...once, schemas: once.schemas.map((s) => ({ ...s, raw: null })) })).toBe(
      JSON.stringify({ ...twice, schemas: twice.schemas.map((s) => ({ ...s, raw: null })) }),
    );
  });

  it("keeps referencedBy consistent with references", () => {
    const graph = buildSchemaGraph(spec);
    for (const node of graph.schemas) {
      for (const target of node.references) {
        const other = graph.schemas.find((s) => s.id === target);
        if (other) expect(other.referencedBy).toContain(node.id);
      }
    }
  });
});
