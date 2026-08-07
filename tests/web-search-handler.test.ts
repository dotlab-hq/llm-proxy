import { expect, test } from 'bun:test';
import { WebSearchHandler } from '../src/core/WebSearchHandler';

const webSearchTool = { type: 'web_search_20250305', name: 'web_search' };

test('does not search when Hermes only advertises web search', () => {
  const handler = new WebSearchHandler();

  expect(handler.shouldUseAnthropicWebSearch({ tools: [webSearchTool] })).toBe(false);
  expect(handler.shouldUseAnthropicWebSearch({
    tools: [webSearchTool],
    tool_choice: { type: 'auto' },
  })).toBe(false);
});

test('searches when Anthropic explicitly selects web search', () => {
  const handler = new WebSearchHandler();

  expect(handler.shouldUseAnthropicWebSearch({
    tools: [webSearchTool],
    tool_choice: { type: 'tool', name: 'web_search' },
  })).toBe(true);
  expect(handler.shouldUseAnthropicWebSearch({
    tools: [webSearchTool],
    tool_choice: 'web_search',
  })).toBe(true);
});
