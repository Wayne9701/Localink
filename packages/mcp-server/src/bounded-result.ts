import type { CallToolResult } from '@modelcontextprotocol/server';

export const RESULT_LIMITS = {
  defaultBytes: 16 * 1024,
  minBytes: 1024,
  maxBytes: 64 * 1024,
} as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function preview(value: Json, width: number, depth = 8): Json {
  if (typeof value === 'string') {
    // Slice the value, never the encoded JSON; avoid splitting surrogate pairs.
    return [...value].slice(0, width).join('');
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth === 0) return null;
  if (Array.isArray(value)) {
    return value.slice(0, width).map((item) => preview(item, width, depth - 1));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, width)
      .map(([key, item]) => [key, preview(item, width, depth - 1)]),
  );
}

export function assertResultLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < RESULT_LIMITS.minBytes ||
    limit > RESULT_LIMITS.maxBytes
  ) {
    throw new RangeError('Invalid Localink result byte limit.');
  }
}

export function boundedResult(
  data: unknown,
  isError = false,
  limit: number = RESULT_LIMITS.defaultBytes,
): CallToolResult {
  assertResultLimit(limit);
  // JSON serialization also honors the frozen SecretValue redacted toJSON.
  // Cycles, bigint, getters, etc. fail closed at the adapter's error boundary.
  const original = JSON.stringify(data);
  if (original === undefined) throw new TypeError('Result must be JSON.');
  const normalized = JSON.parse(original) as Json;
  const originalBytes = Buffer.byteLength(original);
  const make = (value: Json, truncated: boolean): CallToolResult => {
    const envelope = {
      data: value,
      truncation: {
        truncated,
        originalBytes,
        returnedBytes: Buffer.byteLength(JSON.stringify(value)),
        limitBytes: limit,
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      structuredContent: envelope,
      isError,
    };
  };
  // Reserve room for the SDK's modern-protocol result metadata and projection.
  const fits = (result: CallToolResult) =>
    Buffer.byteLength(JSON.stringify(result)) <= limit - 256;
  const full = make(normalized, false);
  if (fits(full)) return full;
  for (let width = 512; width >= 1; width = Math.floor(width / 2)) {
    const reduced = make(preview(normalized, width), true);
    if (fits(reduced)) return reduced;
  }
  return make(null, true);
}
