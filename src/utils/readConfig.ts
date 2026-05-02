
export const readConfig = async ( filePath: string ) => {
    const file = Bun.file( filePath );
    const content = await file.text();

    const data = Bun.JSON5.parse( content );
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