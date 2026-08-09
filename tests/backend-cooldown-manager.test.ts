import { expect, test } from 'bun:test';
import { BackendCooldownManager, isRetryableUpstreamStatus } from '../src/core/BackendCooldownManager';

test( 'isRetryableUpstreamStatus only matches 429 and 5xx statuses', () => {
  expect( isRetryableUpstreamStatus( 200 ) ).toBe( false );
  expect( isRetryableUpstreamStatus( 400 ) ).toBe( false );
  expect( isRetryableUpstreamStatus( 429 ) ).toBe( true );
  expect( isRetryableUpstreamStatus( 500 ) ).toBe( true );
  expect( isRetryableUpstreamStatus( 503 ) ).toBe( true );
  expect( isRetryableUpstreamStatus( 599 ) ).toBe( true );
  expect( isRetryableUpstreamStatus( 600 ) ).toBe( false );
} );

test( 'BackendCooldownManager marks cooldown for retryable statuses and expires it', async () => {
  // Use a much longer cooldown that won't trigger model backoff immediately
  const manager = new BackendCooldownManager( 100 );

  expect( manager.markFromStatus( 'p1', 'm1', 400 ) ).toBe( false );
  expect( manager.isOnCooldown( 'p1', 'm1' ) ).toBe( false );

  // This will trigger the primary cooldown (100ms) AND a model-level backoff
  expect( manager.markFromStatus( 'p1', 'm1', 429 ) ).toBe( true );
  expect( manager.isOnCooldown( 'p1', 'm1' ) ).toBe( true );

  // Wait for both to expire. Base cooldown is 100ms. Model backoff is count * base_ms (2s) = 2s.
  // The logic in markFromStatus applies both.
  await new Promise( resolve => setTimeout( resolve, 2500 ) );
  expect( manager.isOnCooldown( 'p1', 'm1' ) ).toBe( false );
} );

test( 'BackendCooldownManager tracks cooldown per provider-model pair', () => {
  const manager = new BackendCooldownManager( 1_000 );

  manager.markFromStatus( 'provider-a', 'model-a', 500 );
  expect( manager.isOnCooldown( 'provider-a', 'model-a' ) ).toBe( true );
  expect( manager.isOnCooldown( 'provider-a', 'model-b' ) ).toBe( false );
  expect( manager.isOnCooldown( 'provider-b', 'model-a' ) ).toBe( false );
} );

test( 'getModelRemainingMs bypasses provider-level cooldown (sibling-pass hopping)', () => {
  const manager = new BackendCooldownManager( 1_000 );

  // Three distinct-model failures trigger the provider-level cooldown.
  manager.markFromStatus( 'provider-a', 'model-a', 500 );
  manager.markFromStatus( 'provider-a', 'model-b', 500 );
  manager.markFromStatus( 'provider-a', 'model-c', 500 );

  // Provider-level cooldown now blocks the whole provider...
  expect( manager.isOnCooldown( 'provider-a', 'model-d' ) ).toBe( true );
  expect( manager.getRemainingMs( 'provider-a', 'model-d' ) ).toBeGreaterThan( 0 );

  // ...but the model-level view stays clean for untouched models, so the
  // sibling pass can still probe them.
  expect( manager.getModelRemainingMs( 'provider-a', 'model-d' ) ).toBe( 0 );

  // A model that individually failed still reports its own cooldown.
  expect( manager.getModelRemainingMs( 'provider-a', 'model-a' ) ).toBeGreaterThan( 0 );
} );

test( 'recordSuccess decays provider failure count and lifts provider-level cooldown', () => {
  const manager = new BackendCooldownManager( 1_000 );

  manager.markFromStatus( 'provider-a', 'model-a', 500 );
  manager.markFromStatus( 'provider-a', 'model-b', 500 );
  manager.markFromStatus( 'provider-a', 'model-c', 500 );
  expect( manager.getRemainingMs( 'provider-a', 'model-x' ) ).toBeGreaterThan( 0 );

  manager.recordSuccess( 'provider-a' );
  expect( manager.getRemainingMs( 'provider-a', 'model-x' ) ).toBe( 0 );
} );
