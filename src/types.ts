/**
 * The graph model @spec0/schema-graph produces from an OpenAPI document.
 *
 * Nodes are schemas (primary) and operations (optional, toggleable); edges are the
 * relationships a reader wants drawn: schema→schema `$ref` composition and
 * operation→schema usage. Everything is derived from the document alone — no external
 * services, no network.
 */

/** One field of an object schema, summarised for display. */
export interface FieldSummary {
  name: string;
  /** Human-oriented type label, e.g. `string (email)`, `Address`, `Order[]`. */
  type: string;
  required: boolean;
  description?: string;
}

export interface SchemaNode {
  kind: "schema";
  /** The `components/schemas` key, verbatim — unique within the document. */
  id: string;
  name: string;
  description?: string;
  /** Display summary of the schema's own fields (one level). */
  fields: FieldSummary[];
  /** Names of schemas this one references anywhere in its subtree. */
  references: string[];
  /** Names of schemas that reference this one. */
  referencedBy: string[];
  /** True when the schema participates in a `$ref` cycle. */
  cyclic: boolean;
  /**
   * True when the schema has neither fields nor outgoing references — a named
   * primitive (`EventId: {type: string}`), an enum, or an array of scalars.
   *
   * These are real schemas and belong in a list, but as graph nodes they are a
   * box containing a scalar: no structure to reveal and nothing to expand into.
   * In hand-written specs they can be half of `components/schemas`, which is
   * half a canvas of noise; generated specs like Stripe's have none at all.
   */
  simple: boolean;
  /** The verbatim schema subtree, for detail panels / raw views. */
  raw: unknown;
}

export interface OperationNode {
  kind: "operation";
  /** `METHOD path`, unique within the document. */
  id: string;
  method: string;
  path: string;
  summary?: string;
  /** Names of schemas referenced anywhere in the operation subtree. */
  uses: string[];
}

export type GraphNode = SchemaNode | OperationNode;

export interface GraphEdge {
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  kind: "references" | "uses";
}

export interface SchemaGraph {
  title?: string;
  version?: string;
  schemas: SchemaNode[];
  operations: OperationNode[];
  /** `references` edges between schemas plus `uses` edges from operations to schemas. */
  edges: GraphEdge[];
}

export interface BuildOptions {
  /** Include operation nodes and their `uses` edges. Default true. */
  includeOperations?: boolean;
}
