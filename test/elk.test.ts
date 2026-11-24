import { describe, expect, it } from "vitest";
import { buildSchemaGraph } from "../src/graph.js";
import { computeRoutedView, fieldRow } from "../src/elk.js";
import { measureLayout } from "../src/layout-metrics.js";
import { defaultFocus, fieldPreview, fieldRowMiddle, NAME_MIDDLE, OP_H, roundedPath } from "../src/viewmodel.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ content: { "application/json": { schema } } });

// Order lists customer on its box; lineItems, total and shippingAddress sit under
// "+N more". Customer refers back to Order, so one line has to run backwards.
const SPEC = {
  openapi: "3.0.3",
  info: { title: "T", version: "1" },
  paths: {
    "/orders": { get: { responses: { "200": json({ type: "array", items: ref("Order") }) } } },
    "/customers/{id}": { get: { responses: { "200": json(ref("Customer")) } } },
  },
  components: {
    schemas: {
      Order: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["open", "paid"] },
          placedAt: { type: "string", format: "date-time" },
          customer: ref("Customer"),
          lineItems: { type: "array", items: ref("LineItem") },
          total: ref("Money"),
          shippingAddress: ref("Address"),
        },
      },
      Customer: {
        type: "object",
        properties: {
          id: { type: "string" },
          email: { type: "string" },
          orders: { type: "array", items: ref("Order") },
          billingAddress: ref("Address"),
        },
      },
      LineItem: {
        type: "object",
        properties: { sku: { type: "string" }, quantity: { type: "integer" }, unitPrice: ref("Money") },
      },
      Money: { type: "object", properties: { amount: { type: "integer" }, currency: { type: "string" } } },
      Address: { type: "object", properties: { line1: { type: "string" }, city: { type: "string" } } },
    },
  },
};

/** ELK places ports on whole pixels, so a line can land half a pixel off a row's middle. */
function expectNear(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
}

const graph = buildSchemaGraph(SPEC);
const options = { focus: defaultFocus(graph), expanded: new Set<string>(), showOperations: true, showSimple: false };
const schema = (name: string) => graph.schemas.find((s) => s.name === name)!;

describe("computeRoutedView", () => {
  it("routes every line it was given, from the right side of one box to the left side of the other", async () => {
    const view = await computeRoutedView(graph, options);
    expect(view.routes.length).toBe(view.edges.length);
    const box = new Map(view.nodes.map((n) => [n.id, n]));
    for (const route of view.routes) {
      const from = box.get(route.from)!;
      const to = box.get(route.to)!;
      const start = route.points[0]!;
      const end = route.points[route.points.length - 1]!;
      expectNear(start.x, from.x + from.width);
      expectNear(end.x, to.x);
      expectNear(end.y - to.y, NAME_MIDDLE);
    }
  });

  it("starts a reference on the row of the field that makes it", async () => {
    const view = await computeRoutedView(graph, options);
    const order = view.nodes.find((n) => n.id === schema("Order").id)!;
    const toCustomer = view.routes.find((r) => r.from === order.id && r.to === schema("Customer").id)!;
    const row = fieldPreview(schema("Order")).fields.findIndex((f) => f.name === "customer");
    expect(row).toBeGreaterThanOrEqual(0);
    expectNear(toCustomer.points[0]!.y - order.y, fieldRowMiddle(row));
  });

  it("starts a reference from a field the box doesn't list on its \"+N more\" row", async () => {
    const preview = fieldPreview(schema("Order"));
    expect(preview.more).toBeGreaterThan(0);
    expect(preview.fields.some((f) => f.name === "shippingAddress")).toBe(false);
    expect(fieldRow(schema("Order"), "Address")).toBe(preview.fields.length);

    const view = await computeRoutedView(graph, options);
    const order = view.nodes.find((n) => n.id === schema("Order").id)!;
    const toAddress = view.routes.find((r) => r.from === order.id && r.to === schema("Address").id)!;
    expectNear(toAddress.points[0]!.y - order.y, fieldRowMiddle(preview.fields.length));
  });

  it("starts an operation's line from the middle of its box", async () => {
    const view = await computeRoutedView(graph, options);
    const uses = view.routes.filter((r) => r.kind === "uses");
    expect(uses.length).toBeGreaterThan(0);
    for (const route of uses) {
      const op = view.nodes.find((n) => n.id === route.from)!;
      expectNear(route.points[0]!.y - op.y, OP_H / 2);
    }
  });

  it("keeps lines out of boxes and off each other", async () => {
    const view = await computeRoutedView(graph, options);
    const metrics = measureLayout(
      view.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height })),
      view.routes,
    );
    expect(metrics.linesThroughBoxes).toBe(0);
    expect(metrics.sharedLane).toBe(0);
  });

  it("only bends at right angles", async () => {
    const view = await computeRoutedView(graph, options);
    for (const route of view.routes) {
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1]!;
        const b = route.points[i]!;
        expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5).toBe(true);
      }
    }
  });

  it("gives the same layout for the same graph", async () => {
    const a = await computeRoutedView(graph, options);
    const b = await computeRoutedView(graph, options);
    expect(b.nodes.map((n) => [n.id, n.x, n.y])).toEqual(a.nodes.map((n) => [n.id, n.x, n.y]));
    expect(b.routes.map((r) => r.points)).toEqual(a.routes.map((r) => r.points));
  });
});

describe("roundedPath", () => {
  it("draws a straight line as one segment", () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }])).toBe("M0 0 L100 0");
  });

  it("rounds each corner with a curve that stays on the corner", () => {
    const d = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 },
      ],
      8,
    );
    expect(d).toBe("M0 0 L92 0 Q100 0 100 8 L100 50");
  });

  it("shrinks the curve on a short leg so it never overshoots", () => {
    const d = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 6 },
        { x: 40, y: 6 },
      ],
      8,
    );
    expect(d).toBe("M0 0 L7 0 Q10 0 10 3 L10 3 Q10 6 13 6 L40 6");
  });

  it("draws nothing for no points", () => {
    expect(roundedPath([])).toBe("");
  });
});
