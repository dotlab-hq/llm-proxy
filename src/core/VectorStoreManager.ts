/**
 * VectorStoreManager — owns the default vector store lifecycle.
 *
 * On first use it checks whether a well-known default vector store
 * exists in the upstream and creates it if not.  Every uploaded file
 * is automatically attached to this default store so it becomes
 * searchable without any explicit vector-store setup by the client.
 */

import { fetchWithProxy } from '@/utils/proxyFetch';
import { CONFIG } from '@/utils/schema.lookup';

const DEFAULT_STORE_NAME = 'ai-edge-default';
const DEFAULT_STORE_ID_CACHE_KEY = '_default_vector_store_id';

let _defaultStoreId: string | null = null;
let _initialized = false;
let _initLock: Promise<string | null> | null = null;

/**
 * Return the ID of the default vector store, creating it if needed.
 */
export async function getDefaultVectorStoreId(): Promise<string | null> {
    const vs = CONFIG.vectorStore;
    if ( !vs ) return null;

    if ( _defaultStoreId ) return _defaultStoreId;
    if ( _initialized ) return null;

    if ( _initLock ) return _initLock;

    _initLock = ensureDefaultStore();
    return _initLock;
}

/**
 * Force re-initialization (e.g. after config change).
 */
export function resetDefaultVectorStore(): void {
    _defaultStoreId = null;
    _initialized = false;
    _initLock = null;
}

async function ensureDefaultStore(): Promise<string | null> {
    const vs = CONFIG.vectorStore;
    if ( !vs ) {
        _initialized = true;
        return null;
    }

    const base = vs.url.replace( /\/+$/, '' );
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${vs.apiKey}`,
    };

    try {
        // 1. List existing stores and look for default
        const listUrl = `${base}/vector_stores?limit=100`;
        const listRes = await fetchWithProxy( listUrl, { headers }, CONFIG.proxy );
        if ( listRes.ok ) {
            const listPayload = await listRes.json() as any;
            const stores: Array<{ id: string; name?: string }> = Array.isArray( listPayload?.data )
                ? listPayload.data
                : [];
            const existing = stores.find( s => s.name === DEFAULT_STORE_NAME );
            if ( existing ) {
                _defaultStoreId = existing.id;
                _initialized = true;
                console.info( `[vector-store] default_store_found id=${_defaultStoreId}` );
                return _defaultStoreId;
            }
        }

        // 2. Create default store
        const createUrl = `${base}/vector_stores`;
        const createRes = await fetchWithProxy( createUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify( { name: DEFAULT_STORE_NAME } ),
        }, CONFIG.proxy );

        if ( !createRes.ok ) {
            const body = await createRes.text().catch( () => '' );
            console.error( `[vector-store] default_store_create_failed status=${createRes.status} body=${body.slice( 0, 200 )}` );
            _initialized = true;
            return null;
        }

        const created = await createRes.json() as any;
        _defaultStoreId = created?.id ?? null;
        _initialized = true;

        if ( _defaultStoreId ) {
            console.info( `[vector-store] default_store_created id=${_defaultStoreId}` );
        } else {
            console.warn( `[vector-store] default_store_created_no_id_in_response` );
        }

        return _defaultStoreId;
    } catch ( err: any ) {
        console.error( `[vector-store] default_store_init_error error=${err?.message || String( err )}` );
        _initialized = true;
        return null;
    }
}

/**
 * Attach a file (by local file ID) to the default vector store.
 * Returns the upstream vector-store-file object or null on failure.
 */
export async function attachFileToDefaultStore(
    fileId: string,
    attributes?: Record<string, unknown>,
): Promise<{ id: string; status: string } | null> {
    const storeId = await getDefaultVectorStoreId();
    if ( !storeId ) return null;

    const vs = CONFIG.vectorStore;
    if ( !vs ) return null;

    const base = vs.url.replace( /\/+$/, '' );
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${vs.apiKey}`,
    };

    try {
        const url = `${base}/vector_stores/${storeId}/files`;
        const body: Record<string, unknown> = { file_id: fileId };
        if ( attributes ) {
            body.attributes = attributes;
        }

        const response = await fetchWithProxy( url, {
            method: 'POST',
            headers,
            body: JSON.stringify( body ),
        }, CONFIG.proxy );

        if ( !response.ok ) {
            const text = await response.text().catch( () => '' );
            console.warn( `[vector-store] attach_file_failed store=${storeId} file=${fileId} status=${response.status} body=${text.slice( 0, 200 )}` );
            return null;
        }

        const result = await response.json() as any;
        console.info( `[vector-store] file_attached store=${storeId} file=${fileId} vsFileId=${result?.id} status=${result?.status}` );
        return { id: result?.id ?? '', status: result?.status ?? 'unknown' };
    } catch ( err: any ) {
        console.warn( `[vector-store] attach_file_error store=${storeId} file=${fileId} error=${err?.message || String( err )}` );
        return null;
    }
}
