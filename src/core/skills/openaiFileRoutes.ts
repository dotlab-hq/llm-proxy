/**
 * OpenAI-compatible /files route handlers.
 *
 * When a file is uploaded it is automatically attached to the default
 * vector store so it becomes searchable via `file_search` without
 * any explicit setup.
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { FileStore } from '../storage/FileStore';
import type { FileRecord } from '../storage/types';
import { toOpenAIFile, openAIListResponse } from './openaiTransformers';
import { attachFileToDefaultStore } from '../VectorStoreManager';

interface Stores {
  fileStore: FileStore;
  requireStores(): void;
}

/** Optionally attach a file to the default vector store (fire-and-forget). */
function attachToVectorStore( record: FileRecord ): void {
  attachFileToDefaultStore( record.id, {
    filename: record.filename,
    purpose: record.purpose,
    mime_type: record.mime_type,
    downloadable: record.downloadable ?? false,
  } ).catch( ( err: any ) => {
    console.warn( `[openaiFileRoutes] vector_store_attach_failed file=${record.id} error=${err?.message || String( err )}` );
  } );
}

export function setupOpenAIFileRoutes( app: Hono, stores: Stores ): void {
  const listFiles = async ( c: Context ) => {
    try {
      stores.requireStores();
      const limit = Number( c.req.query( 'limit' ) ) || 10000;
      const after = c.req.query( 'after' ) || undefined;
      const purpose = c.req.query( 'purpose' ) || undefined;

      let page_token: string | undefined;
      if ( after ) {
        const afterFile = await stores.fileStore.getFile( after );
        if ( afterFile ) {
          page_token = Buffer.from( String( afterFile.created_at ), 'utf-8' ).toString( 'base64url' );
        }
      }

      const result = await stores.fileStore.listFiles( { limit, purpose, page_token } );
      const files = result.data.map( toOpenAIFile );

      return c.json( openAIListResponse( files, result.has_more ) );
    } catch ( error: any ) {
      console.error( '[/files] listFiles error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
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
        return c.json( toOpenAIFile( record ), 201 );
      } else {
        return c.json( { error: { message: 'Content-Type must be multipart/form-data', type: 'invalid_request_error' } }, 400 );
      }
    } catch ( error: any ) {
      console.error( '[/files] uploadFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  };

  const getFile = async ( c: Context ) => {
    try {
      stores.requireStores();
      const fileId = c.req.param( 'file_id' ) as string;
      const record = await stores.fileStore.getFile( fileId );
      if ( !record ) {
        return c.json( { error: { message: `File not found: ${fileId}`, type: 'invalid_request_error' } }, 404 );
      }
      return c.json( toOpenAIFile( record ) );
    } catch ( error: any ) {
      console.error( '[/files] getFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  };

  const downloadFile = async ( c: Context ) => {
    try {
      stores.requireStores();
      const fileId = c.req.param( 'file_id' ) as string;
      const fileContent = await stores.fileStore.getFileContent( fileId );
      if ( !fileContent ) {
        return c.json( { error: { message: `File not found: ${fileId}`, type: 'invalid_request_error' } }, 404 );
      }
      c.header( 'Content-Type', fileContent.contentType );
      c.header( 'Content-Length', String( fileContent.sizeBytes ) );
      c.header( 'Content-Disposition', `attachment; filename="${fileContent.filename}"` );
      return c.body( new Uint8Array( fileContent.body ) );
    } catch ( error: any ) {
      console.error( '[/files/content] downloadFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  };

  const deleteFile = async ( c: Context ) => {
    try {
      stores.requireStores();
      const fileId = c.req.param( 'file_id' ) as string;
      const deleted = await stores.fileStore.deleteFile( fileId );
      if ( !deleted ) {
        return c.json( { error: { message: `File not found: ${fileId}`, type: 'invalid_request_error' } }, 404 );
      }
      return c.json( { id: fileId, object: 'file.deleted' as const, deleted: true } );
    } catch ( error: any ) {
      console.error( '[/files] deleteFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  };

  app.get( '/files', ( c ) => listFiles( c ) );
  app.post( '/files', ( c ) => uploadFile( c ) );
  app.get( '/files/:file_id', ( c ) => getFile( c ) );
  app.get( '/files/:file_id/content', ( c ) => downloadFile( c ) );
  app.delete( '/files/:file_id', ( c ) => deleteFile( c ) );
}
