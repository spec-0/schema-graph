import { describe, expect, it } from "vitest";
import { buildSchemaGraph, typeLabel } from "../src/graph.js";

const SPEC = `
openapi: 3.0.3
info:
  title: Shop API
  version: 2.1.0
paths:
  /orders:
    get:
      summary: List orders
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Order' }
    post:
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/OrderCreate' }
      responses:
        '201':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
components:
  schemas:
    Order:
      type: object
      description: A customer order.
      required: [id]
      properties:
        id: { type: string }
        address: { $ref: '#/components/schemas/Address' }
        lines:
          type: array
          items: { $ref: '#/components/schemas/OrderLine' }
    OrderCreate:
      type: object
      properties:
        address: { $ref: '#/components/schemas/Address' }
    OrderLine:
      type: object
      properties:
        sku: { type: string }
        parent: { $ref: '#/components/schemas/Order' }
    Address:
      type: object
      properties:
        street: { type: string, description: Street line. }
        country: { type: string, format: iso-3166 }
`;

describe("buildSchemaGraph", () => {
  const graph = buildSchemaGraph(SPEC);

  it("reads document identity", () => {
    expect(graph.title).toBe("Shop API");
    expect(graph.version).toBe("2.1.0");
  });

  it("produces one schema node per component, sorted, with field summaries", () => {
    expect(graph.schemas.map((s) => s.name)).toEqual([
      "Address",
      "Order",
      "OrderCreate",
      "OrderLine",
    ]);
    const order = graph.schemas.find((s) => s.name === "Order")!;
    expect(order.description).toBe("A customer order.");
    expect(order.fields).toEqual([
      { name: "id", type: "string", required: true, description: undefined },
      { name: "address", type: "Address", required: false, description: undefined },
      { name: "lines", type: "OrderLine[]", required: false, description: undefined },
    ]);
  });

  it("draws references edges from $refs, both directions indexed", () => {
    const order = graph.schemas.find((s) => s.name === "Order")!;
    expect(order.references).toEqual(["Address", "OrderLine"]);
    const address = graph.schemas.find((s) => s.name === "Address")!;
    expect(address.referencedBy).toEqual(["Order", "OrderCreate"]);
    expect(
      graph.edges.filter((e) => e.kind === "references" && e.to === "Address").map((e) => e.from),
    ).toEqual(["Order", "OrderCreate"]);
  });

  it("marks cycle participants without recursing forever", () => {
    // Order → OrderLine → Order is a cycle; Address and OrderCreate are not on it.
    const cyclicNames = graph.schemas.filter((s) => s.cyclic).map((s) => s.name);
    expect(cyclicNames).toEqual(["Order", "OrderLine"]);
  });

  it("produces operation nodes with uses edges", () => {
    expect(graph.operations.map((o) => o.id)).toEqual(["GET /orders", "POST /orders"]);
    const post = graph.operations.find((o) => o.id === "POST /orders")!;
    expect(post.uses).toEqual(["Order", "OrderCreate"]);
    expect(
      graph.edges.filter((e) => e.kind === "uses" && e.from === "GET /orders").map((e) => e.to),
    ).toEqual(["Order"]);
  });

  it("can exclude operations", () => {
    const noOps = buildSchemaGraph(SPEC, { includeOperations: false });
    expect(noOps.operations).toEqual([]);
    expect(noOps.edges.every((e) => e.kind === "references")).toBe(true);
  });

  it("accepts JSON input and already-parsed objects", () => {
    const asJson = buildSchemaGraph(
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "J", version: "1" },
        components: { schemas: { A: { type: "object", properties: { b: { type: "string" } } } } },
      }),
    );
    expect(asJson.schemas).toHaveLength(1);
    const asObject = buildSchemaGraph({
      components: { schemas: { A: { type: "string" } } },
    });
    expect(asObject.schemas[0]?.name).toBe("A");
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildSchemaGraph(SPEC))).toBe(JSON.stringify(buildSchemaGraph(SPEC)));
  });
});

describe("typeLabel", () => {
  it.each([
    [{ type: "array", items: { $ref: "#/components/schemas/Order" } }, "Order[]"],
    [{ enum: [1, 2] }, "enum (2)"],
    [{ type: "string", format: "email" }, "string (email)"],
    [{ oneOf: [{}] }, "oneOf"],
    [{ type: ["string", "null"] }, "string | null"],
  ])("labels %j as %s", (schema, expected) => {
    expect(typeLabel(schema as Record<string, unknown>)).toBe(expected);
  });
});
