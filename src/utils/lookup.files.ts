// this will generate all the possible file path for `models.(json|jsonc|yaml|yml)` in the workspace and return the content of the first file found as a JSON object
import path from "path";
const dir =process.cwd();

const FILES = [
  "models.json",
  "models.yaml",
  "models.yml",
  "models.jsonc",
];


const filePaths = FILES.map((fileName) => path.join(dir, fileName));

export {filePaths as MODEL_FILE_PATHS};
