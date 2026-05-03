import path from "path";
import { pathToFileURL } from "node:url";

console.log(pathToFileURL(path.join(process.cwd(), 'schema.json')).href);