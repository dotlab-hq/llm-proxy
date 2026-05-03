// this will check if in the workspace there is file named `models.(json|jsonc|yaml|yml)` and if so, it will read the file and return the content as a JSON object

import { access } from 'node:fs/promises';
import { schema } from "@/schema";
import { MODEL_FILE_PATHS } from "./lookup.files";
import { readConfig } from "./readConfig";

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

const files = await Promise.all(MODEL_FILE_PATHS.map((filePath) => fileExists(filePath)));

const NoOfFilesFound = files.filter(Boolean).length;

if (NoOfFilesFound > 1) {
    throw new Error(`Multiple model configuration files found. Please ensure only one of the following files exists in the workspace: ${MODEL_FILE_PATHS.join(", ")}`)
}

if (NoOfFilesFound === 0) {
    throw new Error(`No model configuration file found. Please ensure one of the following files exists in the workspace: ${MODEL_FILE_PATHS.join(", ")}`)
}

const fileIndex = files.findIndex(Boolean);

const filePath = MODEL_FILE_PATHS[fileIndex] as string;

const fileContent = await readConfig(filePath);

// const validate the file content against the schema
const result = schema.safeParse(fileContent);

if (!result.success) {
    const errorMessages = result.error.issues.map((err) => `- ${err.path.join(".")}: ${err.message}`).join("\n");
    throw new Error(`Model configuration file validation failed with the following errors:\n${errorMessages}`);
}

const data = result.data;

export { data  as CONFIG};