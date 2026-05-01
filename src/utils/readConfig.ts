
export const readConfig = async ( filePath: string ) => {
    const file = Bun.file( filePath );
    const content = await file.text();

    const data = Bun.JSON5.parse( content );
    return data;

}