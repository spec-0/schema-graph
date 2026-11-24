<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/spec-0/schema-graph/main/.github/assets/spec0-schema-graph-dark.svg">
    <img alt="@spec0/schema-graph" src="https://raw.githubusercontent.com/spec-0/schema-graph/main/.github/assets/spec0-schema-graph-light.svg" width="380">
  </picture>
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@spec0/schema-graph"><img alt="npm" src="https://img.shields.io/npm/v/@spec0/schema-graph?color=5B4CF5"></a>
  <a href="https://github.com/spec-0/schema-graph/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/spec-0/schema-graph/ci.yml?branch=main&label=CI"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/npm/l/@spec0/schema-graph?color=52525B"></a>
</p>

<p align="center"><code>npm install @spec0/schema-graph</code></p>

Reads an OpenAPI document and turns its schemas into a graph you can look at.

You give it a spec (YAML or JSON, as a string or an already-parsed object). It
gives you back a plain data model: one node per schema, one node per operation,
and edges for the `$ref` links between schemas and for which operations use
which schemas. There is also an optional React component that draws that model
as an interactive canvas.

It only reads the document you pass in. It makes no network calls.

## Install

```sh
npm install @spec0/schema-graph
```

The React component needs `react` and `react-dom` (18 or 19). If you only use
the data model, you don't need React.

## Usage

Build the graph model:

```ts
import { buildSchemaGraph } from "@spec0/schema-graph";

const graph = buildSchemaGraph(specYamlOrJson);

graph.schemas;    // [{ name, description, fields, references, referencedBy, cyclic, simple, raw }]
graph.operations; // [{ method, path, uses }]
graph.edges;      // [{ from, to, kind: "references" | "uses" }]
```

The output is deterministic: the same document always gives the same graph.
Recursive schemas are marked `cyclic` instead of being followed forever.

Draw it in a React app:

```tsx
import { SchemaGraphView } from "@spec0/schema-graph/react";

export function Schemas({ spec }: { spec: string }) {
  return <SchemaGraphView spec={spec} height={600} />;
}
```

Each schema node lists its first few fields with their types, and a field whose
type is another schema is drawn in the accent colour. An edge between two
schemas is labelled with the field that refers.

The canvas draws its own toggles for operations and for simple types. An app
with its own toolbar can hide them and control both:

```tsx
const [operations, setOperations] = useState(false);

<SchemaGraphView
  spec={spec}
  toolbar={false}
  operations={operations}
  onOperationsChange={setOperations}
  initialSchema={focus}
  onSelectSchema={setFocus}
  hidePanel
/>
```

`operations` and `simple` win over the built-in toggles when set;
`showOperations` and `showSimple` only set where they start. `initialSchema`
centres the canvas on a schema, and `onSelectSchema` with `hidePanel` lets the
app show its own detail view.

The canvas is laid out with [ELK](https://eclipse.dev/elk/) (the Eclipse
Layout Kernel), which places the boxes and routes every line in one pass. Lines
run straight with rounded corners and go around boxes, not through them. A line
leaves from the row of the field that makes it (`customer` on Order), or from
the "+N more" row when that field isn't listed, so you can tell which field each
line belongs to. Lines that would run on top of each other are spaced apart, and
the layout is the same every time for the same graph. ELK is loaded the first
time a graph opens, as its own chunk.

Boxes can be dragged. A line to a box you've moved is drawn straight to it,
until **Tidy up** in the built-in toolbar puts every box back and lays the graph
out again. With your own toolbar, change `tidyUp` (any number) to do the same,
and use `onMovedChange` to know when there's anything to tidy:

```tsx
const [tidy, setTidy] = useState(0);
const [moved, setMoved] = useState(false);

<SchemaGraphView spec={spec} toolbar={false} tidyUp={tidy} onMovedChange={setMoved} />
<button disabled={!moved} onClick={() => setTidy((n) => n + 1)}>Tidy up</button>
```

`layout="dagre"` keeps the layout from before 0.4.0: boxes placed by dagre,
and lines drawn from box to box without routing.

The component imports React Flow's stylesheet, so it needs a bundler that
handles CSS imports (Vite, Next.js, webpack and similar do). In Next.js, add
the package to `transpilePackages`.

## Layout without React

`@spec0/schema-graph/elk` runs the same layout on the data model, for drawing
the graph some other way:

```ts
import { buildSchemaGraph, defaultFocus, roundedPath } from "@spec0/schema-graph";
import { computeRoutedView } from "@spec0/schema-graph/elk";

const graph = buildSchemaGraph(spec);
const view = await computeRoutedView(graph, { focus: defaultFocus(graph), expanded: new Set() });

view.nodes;  // boxes, with x, y, width and height
view.routes; // [{ from, to, kind, points, label }]: every line's start, bends and end
roundedPath(view.routes[0].points); // an SVG path with rounded corners
```

## Theming

The canvas reads CSS custom properties. Each one has a default, so if you set
nothing it still looks fine. Set them on any parent element:

| Property | What it colours |
|---|---|
| `--sg-canvas` | Canvas background |
| `--sg-node-bg` | Schema nodes |
| `--sg-op-bg` | Operation nodes |
| `--sg-border` | Node and container borders |
| `--sg-text` | Node titles |
| `--sg-muted` | Secondary text and `uses` edges |
| `--sg-accent` | Selection and `$ref` edges |
| `--sg-accent-ring` | Selection ring (needs its own value, because alpha can't be applied to a token) |
| `--sg-panel-bg` | Detail panel and toggle chips |
| `--sg-label-bg` | Behind edge labels (defaults to `--sg-node-bg`) |

## Schemas with no structure

A schema with no fields and no outgoing references (a named string, an enum,
an empty marker object) is marked `simple` and is not drawn by default. It is
still in the model. Real specs have a lot of these: Redocly's Museum API has
12 out of 22, and Stripe's spec has 97 empty marker objects among 1440 schemas.
Drawing them all mostly adds noise. The canvas has a toggle to show them, and a
schema you select directly is always drawn.

## What it doesn't do yet

- Only `$ref`s to `#/components/schemas/...` inside the same document become
  edges. References to other files or URLs are ignored, not resolved.
- There is no command-line tool or standalone HTML export. You need to embed
  it in your own page.
- On large specs the canvas shows a limited number of neighbours around the
  selected schema at a time, and offers the rest on request, rather than
  drawing everything at once.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Issues and pull requests are welcome.

## License

MIT. The layout uses [elkjs](https://github.com/kieler/elkjs), which is
licensed under the [Eclipse Public License 2.0](https://www.eclipse.org/legal/epl-2.0/)
and installed as a dependency, unchanged. An app that bundles this package
should include elkjs's licence notice with its other third-party notices.
