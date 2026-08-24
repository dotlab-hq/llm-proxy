import { expect, test, mock } from 'bun:test';

// ── Mock the schema.lookup CONFIG ───────────────────────────────

const mockFetchResponses: Array<{ ok: boolean; status: number; json: any; text?: string }> = [];
let fetchCallIndex = 0;

mock.module( '@/utils/schema.lookup', () => ( {
    CONFIG: {
        vectorStore: {
            url: 'https://vs.example.com',
            apiKey: 'test-key',
        },
        proxy: undefined,
    },
} ) );

mock.module( '@/utils/proxyFetch', () => ( {
    fetchWithProxy: async ( url: string, options: any, _proxy: any ) => {
        const resp = mockFetchResponses[fetchCallIndex++];
        return {
            ok: resp.ok,
            status: resp.status,
            headers: new Map( [['content-type', 'application/json']] ),
            json: async () => resp.json,
            text: async () => resp.text ?? JSON.stringify( resp.json ),
            arrayBuffer: async () => new ArrayBuffer( 0 ),
        };
    },
} ) );

// We need to reset module state between tests — re-import each time
async function freshVectorStoreManager() {
    // Reset the module's internal state
    const m = await import( '../src/core/VectorStoreManager' );
    m.resetDefaultVectorStore();
    return m;
}

test( 'getDefaultVectorStoreId finds existing store', async () => {
    fetchCallIndex = 0;
    mockFetchResponses.length = 0;

    // List stores — includes a store named "ai-edge-default"
    mockFetchResponses.push( {
        ok: true,
        status: 200,
        json: {
            object: 'list',
            data: [
                { id: 'vs_existing', name: 'ai-edge-default' },
                { id: 'vs_other', name: 'My Store' },
            ],
            has_more: false,
        },
    } );

    const { getDefaultVectorStoreId } = await freshVectorStoreManager();
    const id = await getDefaultVectorStoreId();

    expect( id ).toBe( 'vs_existing' );
    // Should only have done one call (list), no create
    expect( fetchCallIndex ).toBe( 1 );
} );

test( 'getDefaultVectorStoreId creates new store when none exists', async () => {
    fetchCallIndex = 0;
    mockFetchResponses.length = 0;

    // List stores — empty
    mockFetchResponses.push( {
        ok: true,
        status: 200,
        json: { object: 'list', data: [], has_more: false },
    } );

    // Create store — returns new ID
    mockFetchResponses.push( {
        ok: true,
        status: 200,
        json: { id: 'vs_newly_created', name: 'ai-edge-default' },
    } );

    const { getDefaultVectorStoreId } = await freshVectorStoreManager();
    const id = await getDefaultVectorStoreId();

    expect( id ).toBe( 'vs_newly_created' );
    expect( fetchCallIndex ).toBe( 2 );
} );

test( 'attachFileToDefaultStore calls correct endpoint', async () => {
    fetchCallIndex = 0;
    mockFetchResponses.length = 0;

    // List stores — creates default
    mockFetchResponses.push( {
        ok: true,
        status: 200,
        json: { object: 'list', data: [{ id: 'vs_default', name: 'ai-edge-default' }] },
    } );

    // Attach file — success
    mockFetchResponses.push( {
        ok: true,
        status: 200,
        json: { id: 'vsf_new', status: 'processing', vector_store_id: 'vs_default' },
    } );

    const { getDefaultVectorStoreId, attachFileToDefaultStore } = await freshVectorStoreManager();

    // Prime the default store
    await getDefaultVectorStoreId();

    const result = await attachFileToDefaultStore( 'file_abc123', { purpose: 'user_data' } );

    expect( result ).not.toBeNull();
    expect( result!.id ).toBe( 'vsf_new' );
    expect( result!.status ).toBe( 'processing' );
    expect( fetchCallIndex ).toBe( 2 );
} );

test( 'getDefaultVectorStoreId caches and only calls once', async () => {
    fetchCallIndex = 0;
    mockFetchResponses.length = 0;

    mockFetchResponses.push( {
        ok: true,
        status: 200,
        json: { object: 'list', data: [{ id: 'vs_cached', name: 'ai-edge-default' }] },
    } );

    const { getDefaultVectorStoreId } = await freshVectorStoreManager();

    const id1 = await getDefaultVectorStoreId();
    expect( id1 ).toBe( 'vs_cached' );

    const id2 = await getDefaultVectorStoreId();
    expect( id2 ).toBe( 'vs_cached' );

    // Only 1 call — second was cached
    expect( fetchCallIndex ).toBe( 1 );
} );
