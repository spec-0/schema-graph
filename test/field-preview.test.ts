import { describe, expect, it } from "vitest";
import { buildSchemaGraph } from "../src/graph.js";
import {
  computeView,
  fieldPreview,
  referenceLabel,
  referencedName,
  schemaHeight,
  schemaWidth,
  PREVIEW_FIELDS,
} from "../src/viewmodel.js";

const graph = buildSchemaGraph({
  openapi: "3.0.3",
  info: { title: "T", version: "1" },
  paths: {},
  components: {
    schemas: {
      Order: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          total: { $ref: "#/components/schemas/Money" },
          lines: { type: "array", items: { $ref: "#/components/schemas/Line" } },
          shipping: { $ref: "#/components/schemas/Money" },
          note: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Money: { type: "object", properties: { amount: { type: "integer" }, currency: { type: "string" } } },
      Line: { type: "object", properties: { sku: { type: "string" } } },
      Wrapped: { allOf: [{ $ref: "#/components/schemas/Money" }] },
    },
  },
});
const schema = (name: string) => graph.schemas.find((s) => s.name === name)!;

describe("a schema node's fields", () => {
  it("lists the first few and counts the rest", () => {
    const { fields, more } = fieldPreview(schema("Order"));
    expect(fields.map((f) => f.name)).toEqual(["id", "total", "lines", "shipping"]);
    expect(fields).toHaveLength(PREVIEW_FIELDS);
    expect(more).toBe(2);
    expect(fieldPreview(schema("Line"))).toMatchObject({ more: 0 });
  });

  it("is as tall as the lines it draws, so layout doesn't overlap nodes", () => {
    // Four fields and a "+2 more" line, against one field and none.
    expect(schemaHeight(schema("Order"))).toBeGreaterThan(schemaHeight(schema("Line")));
    expect(schemaHeight(schema("Line"))).toBeGreaterThan(schemaHeight(schema("Wrapped")));
    const view = computeView(graph, { focus: "Order", expanded: new Set(["Order"]) });
    const order = view.nodes.find((n) => n.id === "Order")!;
    expect(order.height).toBe(schemaHeight(schema("Order")));
    expect(order.width).toBe(schemaWidth(schema("Order")));
  });

  it("is wide enough for a field and its type, within limits", () => {
    expect(schemaWidth(schema("Order"))).toBeGreaterThanOrEqual(220);
    expect(schemaWidth(schema("Order"))).toBeLessThanOrEqual(420);
  });
});

describe("a references edge's label", () => {
  it("names the fields whose type is the target", () => {
    expect(referenceLabel(schema("Order"), "Money")).toBe("total, shipping");
    expect(referenceLabel(schema("Order"), "Line")).toBe("lines");
    expect(referencedName("Line[]")).toBe("Line");
    expect(referencedName("Line[][]")).toBe("Line");
  });

  it("has none when the reference isn't a direct field", () => {
    expect(referenceLabel(schema("Wrapped"), "Money")).toBeUndefined();
  });
});
