import { fetchWithProxy } from '@/utils/proxyFetch';
import { CONFIG } from '@/utils/schema.lookup';
import { getDefaultVectorStoreId } from './VectorStoreManager';

export interface FileSearchResult {
    file_id: string;
    filename: string;
    text: string;
    score: number;
    attributes?: Record<string, string | number | boolean>;
}

export interface FileSearchResponse {
    results: FileSearchResult[];
    queries: string[];
    cached: boolean;
}

/**
 * A filter for file attributes, matching the upstream vector-store's
 * ComparisonFilter / CompoundFilter schema.
 *
 * ComparisonFilter:
 *   { type: "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"in"|"nin", key: string, value: any }
 *
 * AndFilter:
 *   { type: "and", filters: CompoundFilter[] }
 *
 * OrFilter:
 *   { type: "or", filters: CompoundFilter[] }
 */
export type FileFilter =
    | { type: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin'; key: string; value: unknown }
    | { type: 'and'; filters: FileFilter[] }
    | { type: 'or'; filters: FileFilter[] };

export interface FileSearchOptions {
    maxResults?: number;
    /** Filter results by file attributes. Passed as `filters` in the search body. */
    fileFilter?: FileFilter;
}

/**
 * Server-side file search proxy. When the client sends a `file_search` tool
 * in a Responses API request, this manager queries the configured vector store
 * and returns results that are injected as context before forwarding upstream.
 */
export class FileSearchManager {
    isEnabled(): boolean {
        return !!CONFIG.vectorStore;
    }

    private getVectorStoreConfig() {
        return CONFIG.vectorStore;
    }

    /**
     * Resolve the vector store IDs to search.
     * If none are provided, falls back to the default vector store.
     */
    async resolveStoreIds( ids?: string[] ): Promise<string[]> {
        if ( ids && ids.length > 0 ) return ids;
        const defaultId = await getDefaultVectorStoreId();
        return defaultId ? [defaultId] : [];
    }

    /**
     * Execute a file search across one or more vector stores.
     *
     * @param queries  Search query strings.
     * @param vectorStoreIds  Target vector store IDs (falls back to default if empty).
     * @param options  Optional search options including file_filter.
     */
    async search(
        queries: string[],
        vectorStoreIds: string[],
        options?: FileSearchOptions,
    ): Promise<FileSearchResponse> {
        const startedAt = Date.now();
        const vs = this.getVectorStoreConfig();
        if ( !vs ) {
            throw new Error( 'Vector store is not configured' );
        }

        const resolvedIds = await this.resolveStoreIds( vectorStoreIds );
        if ( resolvedIds.length === 0 ) {
            console.warn( `[file-search] no_vector_stores_available — nothing to search` );
            return { results: [], queries, cached: false };
        }

        const maxResults = Math.min( options?.maxResults ?? 20, 50 );
        const base = vs.url.replace( /\/+$/, '' );
        const allResults: FileSearchResult[] = [];

        for ( const vsId of resolvedIds ) {
            try {
                const url = `${base}/vector_stores/${vsId}/search`;

                const body: Record<string, unknown> = {
                    query: queries.length === 1 ? queries[0] : queries,
                    max_num_results: maxResults,
                };

                // Forward file_filter as `filters` to the upstream search
                if ( options?.fileFilter ) {
                    body.filters = options.fileFilter;
                }

                const response = await fetchWithProxy( url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${vs.apiKey}`,
                    },
                    body: JSON.stringify( body ),
                }, CONFIG.proxy );

                if ( !response.ok ) {
                    const body = await response.text().catch( () => '' );
                    console.warn(
                        `[file-search] vector_store_error store=${vsId} status=${response.status} body=${body.slice( 0, 200 )}`,
                    );
                    continue;
                }

                const payload = await response.json() as any;
                const data = Array.isArray( payload?.data ) ? payload.data : [];
                for ( const item of data ) {
                    allResults.push( {
                        file_id: item?.file_id ?? item?.id ?? '',
                        filename: item?.filename ?? item?.attributes?.filename ?? '',
                        text: item?.content ?? item?.text ?? item?.chunk ?? '',
                        score: typeof item?.score === 'number' ? item.score : 0,
                        attributes: item?.attributes,
                    } );
                }
            } catch ( err: any ) {
                console.warn(
                    `[file-search] vector_store_error store=${vsId} error=${err?.message || String( err )}`,
                );
            }
        }

        // Sort by score descending and take top results
        allResults.sort( ( a, b ) => b.score - a.score );
        const limited = allResults.slice( 0, maxResults );

        console.info(
            `[file-search] complete queries=${queries.length} vectorStores=${resolvedIds.length} `
            + `results=${limited.length} durationMs=${Date.now() - startedAt}`,
        );

        return {
            results: limited,
            queries,
            cached: false,
        };
    }
}

export const fileSearchManager = new FileSearchManager();
