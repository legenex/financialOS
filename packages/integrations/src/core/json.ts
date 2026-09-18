import { D, toDecimalString } from '@financialos/domain';

/**
 * Lossless JSON: numbers keep their exact source text so provider amounts never pass through binary floating
 * point. Uses the JSON.parse source-text reviver (available in the supported Node.js runtime).
 */
export class JsonNumber {
  constructor(readonly source: string) {}
  toString(): string {
    return this.source;
  }
  toJSON(): string {
    return this.source;
  }
}

type SourceReviver = (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown;

export function parseJsonLossless(text: string): unknown {
  const reviver: SourceReviver = (_key, value, context) => {
    if (typeof value === 'number') {
      if (typeof context?.source !== 'string') throw new Error('JSON source text access is not available in this runtime');
      return new JsonNumber(context.source);
    }
    return value;
  };
  return JSON.parse(text, reviver as unknown as (key: string, value: unknown) => unknown);
}

/** Normalises a JSON number, numeric string, or bigint into a plain decimal string. Returns null for null/undefined/empty. */
export function toDecimal(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  let text: string;
  if (value instanceof JsonNumber) text = value.source;
  else if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'bigint') text = value.toString();
  else throw new TypeError('Expected a decimal value');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) throw new TypeError('Expected a decimal value');
  return toDecimalString(new D(text));
}

export function toInteger(value: unknown): number | null {
  const dec = toDecimal(value);
  if (dec === null) return null;
  const d = new D(dec);
  if (!d.isInteger() || d.abs().greaterThan(Number.MAX_SAFE_INTEGER)) throw new TypeError('Expected a safe integer');
  return d.toNumber();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof JsonNumber);
}

export function str(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof JsonNumber) return value.source;
  return null;
}

/**
 * Reads a dotted path such as `data.items` or `meta.page.next` (numeric segments index arrays).
 * No wildcards, filters, or script expressions are supported.
 */
export function getPath(root: unknown, path: string): unknown {
  if (path === '' || path === '.') return root;
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export const DOTTED_PATH = /^(?:[A-Za-z0-9_$-]+)(?:\.[A-Za-z0-9_$-]+)*$/;
