import { LocalinkError } from './errors.js';
import type { RichImageBlock } from './contracts.js';

export const RICH_IMAGE_HARD_MAX_BYTES = 5_000_000;
export const RICH_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const;

export function validateRichImageBlock(
  value: unknown,
  maxDecodedBytes: number,
  mimeTypes: readonly string[] = RICH_IMAGE_MIME_TYPES,
): RichImageBlock {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !Number.isSafeInteger(maxDecodedBytes) ||
    maxDecodedBytes < 1 ||
    maxDecodedBytes > RICH_IMAGE_HARD_MAX_BYTES
  ) {
    throw new LocalinkError('CONTRACT_INVALID', 'Invalid rich image boundary.');
  }
  const block = value as Record<string, unknown>;
  if (
    block.type !== 'image' ||
    !RICH_IMAGE_MIME_TYPES.includes(
      block.mimeType as (typeof RICH_IMAGE_MIME_TYPES)[number],
    ) ||
    !mimeTypes.includes(block.mimeType as string) ||
    typeof block.data !== 'string' ||
    block.data.length === 0 ||
    block.data.length > Math.ceil(maxDecodedBytes / 3) * 4 ||
    block.data.length % 4 !== 0
  ) {
    throw new LocalinkError('CONTRACT_INVALID', 'Invalid rich image block.');
  }
  const bytes = Buffer.from(block.data, 'base64');
  if (
    bytes.length === 0 ||
    bytes.length > maxDecodedBytes ||
    bytes.toString('base64') !== block.data
  ) {
    throw new LocalinkError(
      'SIZE_LIMIT_EXCEEDED',
      'Rich image exceeds boundary.',
    );
  }
  const png =
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg =
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255;
  if (
    (block.mimeType === 'image/png' && !png) ||
    (block.mimeType === 'image/jpeg' && !jpeg)
  ) {
    throw new LocalinkError('CONTRACT_INVALID', 'Rich image MIME mismatch.');
  }
  return {
    type: 'image',
    data: block.data,
    mimeType: block.mimeType as RichImageBlock['mimeType'],
  };
}
