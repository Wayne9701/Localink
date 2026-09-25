import { LocalinkError, validateRichImageBlock } from '@localink/sdk';
import type { CapabilityInvokeReceipt } from '@localink/sdk';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { boundedResult } from './bounded-result.js';

export function boundedRichResult(
  receipt: CapabilityInvokeReceipt,
  limit: number,
): CallToolResult {
  if (
    receipt.status !== 'executed' ||
    receipt.policy.tier !== 0 ||
    !Array.isArray(receipt.richContent) ||
    receipt.richContent.length !== 1
  ) {
    throw new LocalinkError('CONTRACT_INVALID', 'Rich result is not eligible.');
  }
  // Validate again at the public boundary, independent of provider validation.
  const image = validateRichImageBlock(receipt.richContent[0], 5_000_000);
  const { richContent: _richContent, ...metadata } = receipt;
  void _richContent;
  const serialized = JSON.stringify(metadata);
  if (serialized === undefined || serialized.includes(image.data)) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Rich result repeats image data.',
    );
  }
  const envelope = boundedResult(metadata, false, limit);
  return {
    ...envelope,
    content: [...envelope.content, image],
    isError: false,
  };
}
