/** Helpers for editing the raw config object by dotted path, and reading field limits from the JSON schema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const splitPath = (path: string) => path.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p));

export function getIn(obj: Any, path: string): Any {
  let cur = obj;
  for (const k of splitPath(path)) {
    if (cur == null) return undefined;
    cur = cur[k as keyof typeof cur];
  }
  return cur;
}

/** Immutable set. `undefined` deletes the key, so the backend default applies again. */
export function setIn<T>(obj: T, path: string, value: unknown): T {
  const keys = splitPath(path);
  const rec = (node: Any, i: number): Any => {
    const k = keys[i];
    const copy = Array.isArray(node) ? [...node] : { ...(node ?? {}) };
    if (i === keys.length - 1) {
      if (value === undefined) {
        if (Array.isArray(copy)) copy.splice(k as number, 1);
        else delete copy[k as string];
      } else copy[k as string] = value;
      return copy;
    }
    copy[k as string] = rec(copy[k as string] ?? (typeof keys[i + 1] === "number" ? [] : {}), i + 1);
    return copy;
  };
  return rec(obj, 0);
}

export interface FieldMeta {
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  multipleOf?: number;
  enum?: string[];
  type?: string;
}

/** Resolve a dotted path in a pydantic JSON schema ($ref, anyOf, arrays) to its limits and default. */
export function fieldMeta(schema: Any, path: string): FieldMeta {
  if (!schema) return {};
  const defs = schema.$defs ?? {};
  const deref = (n: Any): Any => {
    let node = n;
    for (let guard = 0; node && guard < 8; guard++) {
      if (node.$ref) node = { ...defs[node.$ref.split("/").pop()], ...node, $ref: undefined };
      else if (node.anyOf) node = { ...node.anyOf.find((x: Any) => x.type !== "null"), default: node.default };
      else if (node.allOf?.length === 1) node = { ...node.allOf[0], ...node, allOf: undefined };
      else break;
    }
    return node;
  };
  let node = deref(schema);
  for (const k of splitPath(path)) {
    if (!node) return {};
    node = deref(typeof k === "number" ? node.items : node.properties?.[k]);
  }
  return node ?? {};
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
