/**
 * Anthropic-compatible /files route handlers.
 *
 * When a file is uploaded it is automatically attached to the default
 * vector store so it becomes searchable via `file_search` without
 * any explicit setup.
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { FileStore } from '../storage/FileStore';
import type { FileRecord } from '../storage/types';
import { attachFileToDefaultStore } from '../VectorStoreManager';

interface Stores {
  fileStore: FileStore;
  requireStores(): void;
}

/** Convert internal FileRecord → Anthropic Files API response format. */
function toAnthropicFile( r: FileRecord ) {
  return {
    id: r.id,
    type: 'file' as const,
    created_at: new Date( r.created_at * 1000 ).toISOString(),
    filename: r.filename,
    mime_type: r.mime_type,
    purpose: r.purpose,
    size_bytes: r.size_bytes,
    status: r.status,
    scope_id: r.scope_id ?? null,
    downloadable: r.downloadable ?? false,
  };
}

/** Optionally attach a file to the default vector store (fire-and-forget). */
function attachToVectorStore( record: FileRecord ): void {
  attachFileToDefaultStore( record.id, {
    filename: record.filename,
    purpose: record.purpose,
    mime_type: record.mime_type,
    downloadable: record.downloadable ?? false,
  } ).catch( ( err: any ) => {
    console.warn( `[fileRoutes] vector_store_attach_failed file=${record.id} error=${err?.message || String( err )}` );
  } );
}

export function setupFileRoutes( app: Hono, stores: Stores ): void {
  const listFiles = async ( c: Context ) => {
    try {
      stores.requireStores();
      const limit = Number( c.req.query( 'limit' ) ) || undefined;
      const after_id = c.req.query( 'after_id' ) || undefined;
      const before_id = c.req.query( 'before_id' ) || undefined;
      const scope_id = c.req.query( 'scope_id' ) || undefined;
      const result = await stores.fileStore.listFiles( { limit, after_id, before_id, scope_id } );
      return c.json( {
        data: result.data.map( toAnthropicFile ),
        has_more: result.has_more,
        next_page: result.next_page,
      } );
    } catch ( error: any ) {
      console.error( '[/v1/files] listFiles error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  };

  const uploadFile = async ( c: Context ) => {
    try {
      stores.requireStores();
      const contentType = c.req.header( 'content-type' ) ?? '';

      if ( contentType.includes( 'multipart/form-data' ) ) {
        const formData = await c.req.formData();
        const file = formData.get( 'file' );
        const purpose = formData.get( 'purpose' )?.toString() ?? 'user_data';
        const downloadable = formData.get( 'downloadable' )?.toString() === 'true';

        if ( !( file instanceof File ) ) {
          return c.json( { error: { message: 'file is required in multipart form data', type: 'invalid_request_error' } }, 400 );
        }

        const arrayBuffer = await file.arrayBuffer();
        const content = Buffer.from( arrayBuffer );
        const record = await stores.fileStore.uploadFile( {
          filename: file.name,
          mimeType: file.type || undefined,
          purpose,
          content,
          downloadable,
        } );
        attachToVectorStore( record );
        return c.json( toAnthropicFile( record ), 201 );
      } else {
        return c.json( { error: { message: 'Content-Type must be multipart/form-data', type: 'invalid_request_error' } }, 400 );
      }
    } catch ( error: any ) {
      console.error( '[/v1/files] uploadFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  };

  const getFile = async ( c: Context ) => {
    try {
      stores.requireStores();
      const fileId = c.req.param( 'file_id' ) as string;
      const record = await stores.fileStore.getFile( fileId );
      if ( !record ) {
        return c.json( { error: { message: `File not found: ${fileId}`, type: 'not_found_error' } }, 404 );
      }
      return c.json( toAnthropicFile( record ) );
    } catch ( error: any ) {
      console.error( '[/v1/files] getFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  };

  const downloadFile = async ( c: Context ) => {
    try {
      stores.requireStores();
      const fileId = c.req.param( 'file_id' ) as string;
      const fileContent = await stores.fileStore.getFileContent( fileId );
      if ( !fileContent ) {
        return c.json( { error: { message: `File not found: ${fileId}`, type: 'not_found_error' } }, 404 );
      }
      c.header( 'Content-Type', fileContent.contentType );
      c.header( 'Content-Length', String( fileContent.sizeBytes ) );
      c.header( 'Content-Disposition', `attachment; filename="${fileContent.filename}"` );
      return c.body( new Uint8Array( fileContent.body ) );
    } catch ( error: any ) {
      console.error( '[/v1/files/content] downloadFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  };

  const deleteFile = async ( c: Context ) => {
    try {
      stores.requireStores();
      const fileId = c.req.param( 'file_id' ) as string;
      const deleted = await stores.fileStore.deleteFile( fileId );
      if ( !deleted ) {
        return c.json( { error: { message: `File not found: ${fileId}`, type: 'not_found_error' } }, 404 );
      }
      return c.json( { id: fileId, deleted: true } );
    } catch ( error: any ) {
      console.error( '[/v1/files] deleteFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  };

  // Register /v1 and non-prefixed variants
  app.get( '/v1/files', ( c ) => listFiles( c ) );
  app.post( '/v1/files', ( c ) => uploadFile( c ) );
  app.get( '/v1/files/:file_id', ( c ) => getFile( c ) );
  app.get( '/v1/files/:file_id/content', ( c ) => downloadFile( c ) );
  app.delete( '/v1/files/:file_id', ( c ) => deleteFile( c ) );
  app.get( '/files', ( c ) => listFiles( c ) );
  app.post( '/files', ( c ) => uploadFile( c ) );
  app.get( '/files/:file_id', ( c ) => getFile( c ) );
  app.get( '/files/:file_id/content', ( c ) => downloadFile( c ) );
  app.delete( '/files/:file_id', ( c ) => deleteFile( c ) );
}
