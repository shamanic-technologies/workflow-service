/**
 * Apply a stated change to a workflow DAG: a JSON Patch (RFC 6902) subset —
 * `add`, `replace`, `remove`, `test` — evaluated against a CLONE of the DAG, so
 * the source is never mutated and everything the patch does not name stays
 * byte-identical.
 *
 * One addressing convenience on top of the RFC: under `/nodes`, a segment that is
 * not an array index names a node by its `id` (`/nodes/fetch-lead/config/body`).
 * DAG node order is not meaningful and differs between workflows, so a change
 * like "the lead-serving node asks for X" is written once by id instead of being
 * recomputed per workflow. An all-digit segment is always the array index (RFC).
 *
 * Every refusal is a `DagPatchError` naming the operation, before anything is
 * written. Ops apply in order; a failing op leaves no partial result (the clone
 * is simply dropped).
 */

export type DagPatchOperation =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "test"; path: string; value: unknown };

export class DagPatchError extends Error {
  constructor(
    message: string,
    readonly operationIndex: number,
  ) {
    super(message);
    this.name = "DagPatchError";
  }
}

type Container = Record<string, unknown> | unknown[];

function decodeSegment(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parsePath(path: string, i: number): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new DagPatchError(`change ${i}: path "${path}" must start with "/"`, i);
  return path.slice(1).split("/").map(decodeSegment);
}

const isContainer = (v: unknown): v is Container => typeof v === "object" && v !== null;

/** The array index a segment designates in `arr`, resolving a node id under `/nodes`. */
function resolveIndex(arr: unknown[], seg: string, parentKey: string | null, i: number, path: string, forAdd: boolean): number {
  if (/^(0|[1-9][0-9]*)$/.test(seg)) {
    const idx = Number(seg);
    const max = forAdd ? arr.length : arr.length - 1;
    if (idx > max) throw new DagPatchError(`change ${i}: index ${idx} out of range at "${path}"`, i);
    return idx;
  }
  if (seg === "-" && forAdd) return arr.length;
  if (parentKey === "nodes") {
    const idx = arr.findIndex((n) => isContainer(n) && !Array.isArray(n) && n.id === seg);
    if (idx === -1) throw new DagPatchError(`change ${i}: no node with id "${seg}" at "${path}"`, i);
    return idx;
  }
  throw new DagPatchError(`change ${i}: "${seg}" is not an array index at "${path}"`, i);
}

/** Walk to the parent of the last segment. */
function walk(root: unknown, segs: string[], i: number, path: string): { parent: Container; key: string; parentKey: string | null } {
  let cur: unknown = root;
  let curKey: string | null = null;
  for (const seg of segs.slice(0, -1)) {
    if (Array.isArray(cur)) {
      cur = cur[resolveIndex(cur, seg, curKey, i, path, false)];
    } else if (isContainer(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
        throw new DagPatchError(`change ${i}: "${seg}" does not exist on the way to "${path}"`, i);
      }
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      throw new DagPatchError(`change ${i}: cannot descend into a non-object at "${path}"`, i);
    }
    curKey = seg;
  }
  if (!isContainer(cur)) throw new DagPatchError(`change ${i}: the parent of "${path}" is not an object or array`, i);
  return { parent: cur, key: segs[segs.length - 1], parentKey: curKey };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isContainer(v)) {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** PURE: the DAG with every operation applied in order. Throws DagPatchError; never mutates `dag`. */
export function applyDagPatch<T>(dag: T, operations: DagPatchOperation[]): T {
  const doc = structuredClone(dag) as unknown;
  operations.forEach((operation, i) => {
    const segs = parsePath(operation.path, i);
    if (segs.length === 0) throw new DagPatchError(`change ${i}: replacing the whole DAG is not a change; name a path`, i);
    const { parent, key, parentKey } = walk(doc, segs, i, operation.path);
    const has = Array.isArray(parent) ? true : Object.prototype.hasOwnProperty.call(parent, key);

    switch (operation.op) {
      case "add": {
        if (Array.isArray(parent)) {
          const idx = resolveIndex(parent, key, parentKey, i, operation.path, true);
          parent.splice(idx, 0, structuredClone(operation.value));
        } else {
          parent[key] = structuredClone(operation.value);
        }
        return;
      }
      case "replace": {
        if (Array.isArray(parent)) {
          parent[resolveIndex(parent, key, parentKey, i, operation.path, false)] = structuredClone(operation.value);
        } else {
          if (!has) throw new DagPatchError(`change ${i}: "${operation.path}" does not exist (use "add" to create it)`, i);
          parent[key] = structuredClone(operation.value);
        }
        return;
      }
      case "remove": {
        if (Array.isArray(parent)) {
          parent.splice(resolveIndex(parent, key, parentKey, i, operation.path, false), 1);
        } else {
          if (!has) throw new DagPatchError(`change ${i}: "${operation.path}" does not exist`, i);
          delete parent[key];
        }
        return;
      }
      case "test": {
        const actual = Array.isArray(parent)
          ? parent[resolveIndex(parent, key, parentKey, i, operation.path, false)]
          : has
            ? parent[key]
            : undefined;
        if (!has || !deepEqual(actual, operation.value)) {
          throw new DagPatchError(
            `change ${i}: test failed at "${operation.path}": expected ${JSON.stringify(operation.value)}, found ${JSON.stringify(actual)}`,
            i,
          );
        }
        return;
      }
    }
  });
  return doc as T;
}
