import { expect, test } from 'bun:test';
import { normalizeAnthropicSseEvent } from '../src/core/anthropic/bridge/processing';

test('normalizes only a null Anthropic SSE index', () => {
  expect(normalizeAnthropicSseEvent({ type: 'content_block_delta', index: null })).toEqual({
    type: 'content_block_delta',
    index: 0,
  });
  expect(normalizeAnthropicSseEvent({ type: 'content_block_delta', index: 2 })).toEqual({
    type: 'content_block_delta',
    index: 2,
  });
  expect(normalizeAnthropicSseEvent({ type: 'content_block_delta', index: null, delta: { index: null } })).toEqual({
    type: 'content_block_delta',
    index: 0,
    delta: { index: null },
  });
});
