// this will generate all the possible file path for `model.(json|jsonc|yaml|yml)` or `models.(json|jsonc|yaml|yml)` in the workspace and return the content of the first file found as a JSON object
import path from "path";
const dir = process.cwd();

const FILES = [
  "model.jsonc",
  "model.json",
  "model.yaml",
  "model.yml",
  "model.toml",
  "models.jsonc",
  "models.json",
  "models.yaml",
  "models.yml",
  "models.toml",
];


const filePaths = FILES.map( ( fileName ) => path.join( dir, fileName ) );

export { filePaths as MODEL_FILE_PATHS };
