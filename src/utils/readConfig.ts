
import { readFile } from 'node:fs/promises';
import JSON5 from 'json5';

export const readConfig = async ( filePath: string ) => {
    const content = await readFile( filePath, 'utf-8' );

    const data = JSON5.parse( content );
    const substituted = substituteEnvVars( data );
    return substituted;
}

function substituteEnvVars( obj: any ): any {
    if ( typeof obj === 'string' ) {
        return obj.replace( /\$\{([^}]+)\}/g, ( _, varName ) => {
            return process.env[ varName ] ?? `\${${varName}}`;
        } );
    }
    if ( Array.isArray( obj ) ) {
        return obj.map( substituteEnvVars );
    }
    if ( obj !== null && typeof obj === 'object' ) {
        const result: any = {};
        for ( const [ key, value ] of Object.entries( obj ) ) {
            result[ key ] = substituteEnvVars( value );
        }
        return result;
    }
    return obj;
}