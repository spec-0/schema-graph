import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { edgeRoute, FORWARD_GAP } from "../src/viewmodel.js";

const box = (x: number, y = 0, width = 220) => ({ x, y, width });

describe("edgeRoute", () => {
  it("runs forward when the target is to the right with room between", () => {
    expect(edgeRoute("A", "B", box(0), box(220 + FORWARD_GAP))).toBe("forward");
    expect(edgeRoute("A", "B", box(0), box(400, 300))).toBe("forward");
  });

  it("goes under the row when the target is behind, level or too close", () => {
    expect(edgeRoute("A", "B", box(400), box(0))).toBe("backward");
    expect(edgeRoute("A", "B", box(0), box(0, 200))).toBe("backward");
    expect(edgeRoute("A", "B", box(0), box(220 + FORWARD_GAP - 1))).toBe("backward");
  });

  it("goes over the row when the target behind sits higher", () => {
    expect(edgeRoute("A", "B", box(400, 300), box(0, 100))).toBe("over");
    // Middles, not tops: a tall source whose top is higher can still sit lower.
    expect(edgeRoute("A", "B", { ...box(400, 90), height: 200 }, { ...box(0, 100), height: 60 })).toBe("over");
    expect(edgeRoute("A", "B", { ...box(400, 100), height: 60 }, { ...box(0, 90), height: 200 })).toBe("backward");
  });

  it("follows a box the user dragged", () => {
    const target = box(400);
    expect(edgeRoute("A", "B", box(0), target)).toBe("forward");
    expect(edgeRoute("A", "B", box(0), { ...target, x: -300 })).toBe("backward");
  });

  it("loops a schema that refers to itself", () => {
    expect(edgeRoute("A", "A", box(0), box(0))).toBe("self");
  });

  it("falls back to forward before positions are known", () => {
    expect(edgeRoute("A", "B", undefined, box(0))).toBe("forward");
  });
});

// Source assertions, like canvas-toolbar.test.ts: the suite has no DOM.
const here = dirname(fileURLToPath(import.meta.url));
const view = readFileSync(resolve(here, "../src/react/SchemaGraphView.tsx"), "utf8");

describe("SchemaGraphView lines", () => {
  it("draws straight lines with rounded corners, not the default curve", () => {
    expect(view).toMatch(/type: "smoothstep"/);
    expect(view).toMatch(/borderRadius: \d+/);
  });

  it("has a handle for every route", () => {
    for (const id of ["in", "in-bottom", "in-top", "out", "out-bottom", "out-top"]) {
      expect(view).toContain(`id="${id}"`);
    }
  });

  it("offers Tidy up in the built-in toolbar and to embedders", () => {
    expect(view).toContain("Tidy up");
    expect(view).toMatch(/tidyUp\?: number/);
    expect(view).toMatch(/onMovedChange\?: \(moved: boolean\) => void/);
  });
});
