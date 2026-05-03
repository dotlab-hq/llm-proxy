import { writeFile } from 'node:fs/promises';
import { schema } from "@/schema";

await writeFile("schema.json", JSON.stringify(schema.toJSONSchema(), null, 2));