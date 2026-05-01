import path from "path";

console.log(Bun.pathToFileURL(path.join(process.cwd(), 'schema.json')).href);