/**
 * The canvas toggles, guarded at the source.
 *
 * This component renders inside somebody else's application, and therefore
 * inside somebody else's stylesheet. Both bugs these tests guard came from
 * forgetting that.
 *
 * The first was ours alone: each toggle positioned itself absolutely at a
 * hand-measured offset, so any change to a label or a font size moved one and
 * not the other.
 *
 * The second only appeared in a host. A bare `<input type="checkbox">` inherits
 * whatever the host says about `input`, and `input { width: 100% }` is a common
 * rule. The checkbox inflated to eighty-odd pixels, filled its
 * pill, and pushed the label out of the side of it. The package looked correct
 * in isolation and wrong everywhere it was actually used, which is why these
 * assertions are about *stating* values rather than inheriting them.
 *
 * Source assertions rather than rendered ones: the package's suite is pure
 * logic with no DOM, and adding a browser to it to measure one checkbox would
 * cost more than it protects. Layout is verified by rendering in a host before
 * release; this is the cheap net that catches the styling being dropped.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, "../src/react/SchemaGraphView.tsx"), "utf8");

/**
 * Comments are stripped before asserting.
 *
 * These tests first failed against a file that was already correct, because the
 * comment explaining why `top: 46` was removed contains the string `top: 46`,
 * and the comment describing `<input type="checkbox">` counts as a third
 * checkbox. A guard that trips on its own explanation is worse than no guard:
 * it fails when nothing is wrong and teaches whoever sees it to stop reading.
 */
const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the toggles are laid out, not positioned by hand", () => {
  it("has no hand-measured offset", () => {
    // `top: 46` was "roughly where the first pill ends", maintained by nobody.
    expect(source).not.toMatch(/top:\s*46/);
  });

  it("puts both toggles in one container", () => {
    expect(source).toContain('className="sg-toolbar"');
    const toolbar = source.slice(source.indexOf('className="sg-toolbar"'));
    // Both checkboxes live inside it, so they cannot drift apart.
    expect(toolbar).toContain("setShowOperations");
    expect(toolbar).toContain("setShowSimple");
  });

  it("lets the group wrap rather than run off the canvas", () => {
    const toolbar = source.slice(source.indexOf('className="sg-toolbar"'));
    expect(toolbar).toMatch(/flexWrap:\s*"wrap"/);
  });

  it("defines the toggle style once rather than per toggle", () => {
    // Two copies is how they diverged the first time.
    expect(source.match(/const toggleStyle/g) ?? []).toHaveLength(1);
    expect(source.match(/style=\{toggleStyle\}/g) ?? []).toHaveLength(2);
  });
});

describe("the checkbox survives a host stylesheet", () => {
  it("states its own size instead of inheriting one", () => {
    expect(source).toContain("const checkboxStyle");
    const style = source.slice(source.indexOf("const checkboxStyle"));
    const block = style.slice(0, style.indexOf("};"));
    // A host's `input { width: 100% }` is what broke this; an explicit width and
    // a floor under it are what stop the box swallowing its own label.
    expect(block).toMatch(/width:\s*\d+/);
    expect(block).toMatch(/minWidth:\s*\d+/);
    expect(block).toMatch(/height:\s*\d+/);
    // Padding and margin are equally inheritable, and equally distorting.
    expect(block).toMatch(/padding:\s*0/);
    expect(block).toMatch(/margin:\s*0/);
    expect(block).toMatch(/flex:\s*"none"/);
  });

  it("applies that style to every checkbox it renders", () => {
    const applied = source.match(/style=\{checkboxStyle\}/g) ?? [];
    const inputs = source.match(/type="checkbox"/g) ?? [];
    expect(applied).toHaveLength(inputs.length);
  });
});

describe("the overlays follow the host's theme", () => {
  // The truncation notice hardcoded `#ffffffee` while everything around it read
  // `--sg-*`, so it was a white card on a dark canvas.
  it("has no hardcoded colour in the overlays", () => {
    const overlays = source.slice(source.indexOf("view.truncated.length > 0"));
    const region = overlays.slice(0, overlays.indexOf("</div>"));
    expect(region).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
