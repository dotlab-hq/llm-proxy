import { expect, test } from 'bun:test';
import { openAIProxy } from '../src/core/OpenAIProxy';
import { anthropicProxy } from '../src/core/AnthropicProxy';
import { rateLimitManager } from '../src/core/RateLimitManager';

// ── Sibling-pass routing (last-resort model substitution) ─────────────────
//
// Design: when an explicitly requested model is exhausted across every
// provider in its groupSpace, providers that PARTICIPATE in random routing
// (randomRouting !== false) offer their OTHER models as substitution — the
// return benefit of taking part in random routing. Group isolation stays
// intact: the sibling pass never crosses groupSpaces. Providers with
// randomRouting === false only ever serve the exact requested model.

const OAI = openAIProxy as any;
const ANTH = anthropicProxy as any;

function provider( id: string, models: string[], overrides: Record<string, unknown> = {} ): any {
    return {
        id,
        name: id,
        models,
        randomRouting: true,
        baseUrl: `https://${id}.example.com/v1`,
        apiKey: `key-${id}`,
        ...overrides,
    };
}

test( 'explicit model request: providers return ONLY the requested model (no siblings in pass 1)', () => {
    const config = provider( 'gemini-1', ['gemini-2.5-flash', 'gemini-3.6-flash'] );
    expect( OAI.getCandidateModelsForProvider( config, 'gemini-3.6-flash' ) ).toEqual( ['gemini-3.6-flash'] );
} );

test( 'sibling pass: participating provider offers capped, deduped siblings excluding the requested model', () => {
    const config = provider( 'gemini-1', [
        'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash',
        'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash',
    ] );
    const siblings = OAI.getCandidateModelsForProvider( config, 'gemini-3.6-flash', true );
    expect( siblings ).not.toContain( 'gemini-3.6-flash' );
    expect( siblings.length ).toBeGreaterThan( 0 );
    expect( siblings.length ).toBeLessThanOrEqual( 4 );
    expect( new Set( siblings ).size ).toBe( siblings.length );
    // Same semantics in the Anthropic proxy
    const anthSiblings = ANTH.getCandidateModelsForProvider( config, 'gemini-3.6-flash', ['text'], true );
    expect( anthSiblings ).not.toContain( 'gemini-3.6-flash' );
    expect( anthSiblings.length ).toBeGreaterThan( 0 );
    expect( anthSiblings.length ).toBeLessThanOrEqual( 4 );
} );

test( 'non-participating provider (randomRouting=false) gets NO sibling pass in either proxy', () => {
    const strict = provider( 'strict', ['gpt-4', 'gpt-4o'], { randomRouting: false } );
    expect( OAI.getCandidateModelsForProvider( strict, 'gpt-4', true ) ).toEqual( ['gpt-4'] );
    expect( ANTH.getCandidateModelsForProvider( strict, 'gpt-4', ['text'], true ) ).toEqual( ['gpt-4'] );
} );

test( 'auto-edge requests never trigger sibling retry lists (auto is not a sibling of itself)', () => {
    const config = provider( 'zen-1', ['deepseek-v4-flash-free', 'mimo-v2.5-free'] );
    // Auto model: provider offers its full list (existing behavior), and the
    // sibling variant for "auto" must not produce a duplicate "auto" entry.
    const siblings = OAI.getCandidateModelsForProvider( config, 'auto', true );
    expect( siblings ).not.toContain( 'auto' );
} );

test( 'real config: gemini-3.6-flash fallback stays inside the gemini group (no cross-group leak)', () => {
    const backends = OAI.getBackendsForModel( 'gemini-3.6-flash', 'chat/completions' );
    const ids = backends.map( ( b: any ) => b.id );
    // Exact gemini providers present (gemini-3 and gemini-6 share one apiKey,
    // so they dedupe to a single backend) and NO default-group providers.
    expect( ids.length ).toBeGreaterThanOrEqual( 5 );
    expect( ids ).toEqual( expect.arrayContaining( ['gemini-1', 'gemini-2', 'gemini-4', 'gemini-5'] ) );
    expect( ids.every( ( id: string ) => id.startsWith( 'gemini' ) ) ).toBe( true );
    // Sibling pass for every in-group backend yields only sibling models.
    for ( const b of backends ) {
        const siblings = OAI.getCandidateModelsForProvider( b, 'gemini-3.6-flash', true );
        expect( siblings ).not.toContain( 'gemini-3.6-flash' );
        expect( siblings.length ).toBeLessThanOrEqual( 4 );
    }
} );

// ── Preemptive TPM-meter hop ──────────────────────────────────────────────
//
// The meter (rateLimitManager.peekRemaining) is the refill-aware token-bucket
// peek the loop consults BEFORE attempting upstream, so Gemini providers with
// low TPM hop to the next turn instead of burning a call and waiting for 429.

test( 'peekRemaining: refill-aware meter peek (no consumption)', async () => {
    const rl = { tokensPerMinute: 6000 };
    const id = 'meter-test-provider';
    const model = 'meter-test-model';

    // Drain the bucket entirely (6000 tokens = initial bucket).
    const first = await rateLimitManager.checkAndConsume( id, 6000, rl, model );
    expect( first.allowed ).toBe( true );

    // Immediately after draining: remaining is ~0 (refill is 100 tokens/sec,
    // so < 2s of test runtime → well under the request size).
    const drained = await rateLimitManager.peekRemaining( id, rl, model );
    expect( drained ).not.toBeNull();
    expect( drained! ).toBeLessThan( 600 );

    // A follow-up consume must be rejected (reactive limiter still works).
    const second = await rateLimitManager.checkAndConsume( id, 100, rl, model );
    expect( second.allowed ).toBe( false );

    // No rate limit configured → peek returns null (treated as unlimited).
    expect( await rateLimitManager.peekRemaining( id, undefined, model ) ).toBeNull();

    await rateLimitManager.reset( id, model );
} );

test( 'getEffectiveRateLimit resolves the per-model rateLimit from the models array (gemini config)', () => {
    const cfg = provider( 'gemini-x', [], {
        models: [
            { model: 'gemini-3.6-flash', rateLimit: { tokensPerMinute: 250000, requestsPerMinute: 5, requestsPerDay: 20 } },
            'gemini-3.5-flash',
        ],
        individualLimit: true,
    } );
    // Per-model entry wins for the model that carries one.
    expect( OAI.getEffectiveRateLimit( cfg, 'gemini-3.6-flash' ) ).toEqual( {
        tokensPerMinute: 250000,
        requestsPerMinute: 5,
        requestsPerDay: 20,
    } );
    expect( ANTH.getEffectiveRateLimit( cfg, 'gemini-3.6-flash' ) ).toEqual( {
        tokensPerMinute: 250000,
        requestsPerMinute: 5,
        requestsPerDay: 20,
    } );
    // String-only model → no per-model entry → falls back (undefined here).
    expect( OAI.getEffectiveRateLimit( cfg, 'gemini-3.5-flash' ) ).toBeUndefined();
} );
