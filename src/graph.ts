import { load } from "js-yaml";
import type {
  BuildOptions,
  FieldSummary,
  GraphEdge,
  OperationNode,
  SchemaGraph,
  SchemaNode,
} from "./types.js";

const SCHEMA_REF_PREFIX = "#/components/schemas/";
const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
]);

type Json = Record<string, unknown>;

/** Parse a spec given as YAML/JSON text or an already-parsed object. */
export function parseSpec(input: string | object): Json {
  if (typeof input !== "string") {
    return input as Json;
  }
  const trimmed = input.trimStart();
  const doc = trimmed.startsWith("{") ? JSON.parse(input) : load(input);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("OpenAPI document root must be an object");
  }
  return doc as Json;
}

/**
 * Build the schema graph of one OpenAPI document. Pure and deterministic: the same
 * document always yields the same nodes and edges, ordered by name.
 */
export function buildSchemaGraph(input: string | object, options?: BuildOptions): SchemaGraph {
  const doc = parseSpec(input);
  const includeOperations = options?.includeOperations !== false;

  const info = (doc.info ?? {}) as Json;
  const schemasObj = schemasOf(doc);

  const references = new Map<string, Set<string>>();
  const referencedBy = new Map<string, Set<string>>();
  for (const [name, schema] of Object.entries(schemasObj)) {
    const refs = collectSchemaRefs(schema);
    refs.delete(name);
    references.set(name, refs);
    for (const target of refs) {
      if (!referencedBy.has(target)) referencedBy.set(target, new Set());
      referencedBy.get(target)!.add(name);
    }
  }

  const cyclic = findCyclicSchemas(references);

  const schemas: SchemaNode[] = Object.entries(schemasObj)
    .map(([name, schema]) => ({
      kind: "schema" as const,
      id: name,
      name,
      description: stringOrUndefined((schema as Json)?.description),
      fields: fieldSummaries(schema as Json),
      references: [...(references.get(name) ?? [])].sort(),
      referencedBy: [...(referencedBy.get(name) ?? [])].sort(),
      cyclic: cyclic.has(name),
      simple:
        fieldSummaries(schema as Json).length === 0 && (references.get(name)?.size ?? 0) === 0,
      raw: schema,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const operations: OperationNode[] = includeOperations ? operationNodes(doc) : [];

  const edges: GraphEdge[] = [];
  for (const s of schemas) {
    for (const target of s.references) {
      if (definesSchema(schemasObj, target)) {
        edges.push({ from: s.id, to: target, kind: "references" });
      }
    }
  }
  for (const op of operations) {
    for (const target of op.uses) {
      if (definesSchema(schemasObj, target)) {
        edges.push({ from: op.id, to: target, kind: "uses" });
      }
    }
  }

  return {
    title: stringOrUndefined(info.title),
    version: stringOrUndefined(info.version),
    schemas,
    operations,
    edges,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function schemasOf(doc: Json): Record<string, unknown> {
  const components = doc.components as Json | undefined;
  const schemas = components?.schemas;
  if (!schemas || typeof schemas !== "object" || Array.isArray(schemas)) {
    return {};
  }
  return schemas as Record<string, unknown>;
}

function operationNodes(doc: Json): OperationNode[] {
  const paths = doc.paths;
  if (!paths || typeof paths !== "object") return [];
  const nodes: OperationNode[] = [];
  for (const [path, item] of Object.entries(paths as Json)) {
    if (!item || typeof item !== "object") continue;
    for (const [method, op] of Object.entries(item as Json)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const uses = [...collectSchemaRefs(op)].sort();
      nodes.push({
        kind: "operation",
        id: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: stringOrUndefined((op as Json)?.summary),
        uses,
      });
    }
  }
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Every `#/components/schemas/...` reference reachable from `node`.
 *
 * Iterative, with a seen-set, and both of those are load-bearing rather than
 * stylistic — this walks a document supplied by whoever wrote the spec:
 *
 *  - **Cycles.** YAML aliases may point at an ancestor anchor, so nine lines of
 *    valid YAML produce a genuinely circular object. A caller passing an
 *    already-parsed object can hand us one directly. Recursion without a
 *    seen-set does not return.
 *  - **Shared subtrees.** js-yaml resolves an alias to *the same object*, not a
 *    copy, so an aliased fan-out is a DAG. Walking it by path is exponential:
 *    24 levels took 1.6 seconds before this, and each further level doubles it.
 *    That is the billion-laughs shape, and the seen-set is the whole defence.
 *  - **Depth.** A deeply nested document overflows the stack long before it
 *    exhausts memory; an explicit stack turns that into ordinary work.
 *
 * The result is unchanged — refs already accumulated into a Set, so skipping a
 * subtree we have visited cannot lose one.
 */
function collectSchemaRefs(node: unknown): Set<string> {
  const out = new Set<string>();
  const seen = new WeakSet<object>();
  const stack: unknown[] = [node];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current as object)) continue;
    seen.add(current as object);

    if (Array.isArray(current)) {
      for (const child of current) stack.push(child);
      continue;
    }

    const obj = current as Json;
    const ref = obj.$ref;
    if (typeof ref === "string" && ref.startsWith(SCHEMA_REF_PREFIX)) {
      out.add(ref.slice(SCHEMA_REF_PREFIX.length));
    }
    for (const value of Object.values(obj)) stack.push(value);
  }
  return out;
}

/**
 * Does the document actually define this schema?
 *
 * `in` walks the prototype chain, so `"constructor" in schemas` is true for
 * every object alive. A spec referencing `#/components/schemas/constructor`
 * therefore produced an edge to a node that was never in the node list, and a
 * renderer drawing edges by id got a dangling one.
 */
function definesSchema(schemas: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(schemas, name);
}

/**
 * Nodes on any directed cycle of the references graph.
 *
 * DFS with colouring, driven by an explicit stack. The recursive form
 * overflowed at around five thousand chained schemas — well inside the range of
 * a real document, since Stripe alone defines about fourteen hundred — and a
 * chain is the ordinary shape of a spec that models a linked structure.
 */
function findCyclicSchemas(references: Map<string, Set<string>>): Set<string> {
  const cyclic = new Set<string>();
  const done = new Set<string>();
  /** Position of each name in `path`, for finding where a back-edge closes. */
  const depth = new Map<string, number>();

  for (const root of references.keys()) {
    if (done.has(root)) continue;

    const path: string[] = [];
    const frames: Array<{ name: string; targets: Iterator<string> }> = [];

    const enter = (name: string) => {
      depth.set(name, path.length);
      path.push(name);
      frames.push({ name, targets: (references.get(name) ?? new Set<string>()).values() });
    };
    enter(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const step = frame.targets.next();

      if (step.done) {
        frames.pop();
        path.pop();
        depth.delete(frame.name);
        done.add(frame.name);
        continue;
      }

      const target = step.value;
      if (!references.has(target) || done.has(target)) continue;

      const closesAt = depth.get(target);
      if (closesAt !== undefined) {
        // Back edge: everything from the target's own position onwards is on the cycle.
        for (let i = closesAt; i < path.length; i += 1) cyclic.add(path[i]!);
        continue;
      }
      enter(target);
    }
  }
  return cyclic;
}

function fieldSummaries(schema: Json | undefined): FieldSummary[] {
  if (!schema) return [];
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return [];
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(properties as Json).map(([name, def]) => ({
    name,
    type: typeLabel(def as Json | undefined),
    required: required.has(name),
    description: stringOrUndefined((def as Json)?.description),
  }));
}

/** Human-oriented type label: `Address`, `string (email)`, `Order[]`, `enum (3)`, … */
export function typeLabel(schema: Json | undefined): string {
  if (!schema) return "unknown";
  const ref = schema.$ref;
  if (typeof ref === "string") return ref.split("/").pop() ?? ref;
  if (Array.isArray(schema.enum)) return `enum (${schema.enum.length})`;
  if (Array.isArray(schema.allOf)) return "allOf";
  if (Array.isArray(schema.anyOf)) return "anyOf";
  if (Array.isArray(schema.oneOf)) return "oneOf";
  const t = Array.isArray(schema.type) ? (schema.type as string[]).join(" | ") : schema.type;
  if (t === "array") return `${typeLabel(schema.items as Json | undefined)}[]`;
  if (typeof t !== "string") return schema.properties ? "object" : "unknown";
  if (typeof schema.format === "string") return `${t} (${schema.format})`;
  return t;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
