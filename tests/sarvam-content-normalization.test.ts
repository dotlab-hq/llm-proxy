import { expect, test } from 'bun:test';
import { isStringContentOnlyProvider, normalizeMessagesContentToString } from '../src/core/routing/shared';

test( 'detects Sarvam provider from baseUrl', () => {
  expect( isStringContentOnlyProvider( { baseUrl: 'https://api.sarvam.ai/v1' } ) ).toBe( true );
  expect( isStringContentOnlyProvider( { baseUrl: 'https://api.openai.com/v1' } ) ).toBe( false );
} );

test( 'flattens array message content into strings for strict providers', () => {
  const body = {
    model: 'sarvam-105b',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Hello' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          { type: 'input_text', text: 'Summarize this' },
        ],
      },
    ],
  };

  const normalized = normalizeMessagesContentToString( body ) as any;
  expect( normalized.messages[1].content ).toBe( 'Hello\n[Image attachment]\nSummarize this' );
} );

