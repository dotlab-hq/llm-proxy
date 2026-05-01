import { schema } from "@/schema";

Bun.write("schema.json", JSON.stringify(schema.toJSONSchema(), null, 2));