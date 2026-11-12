// Refresh the copy of the published Enrich Layer v3 OpenAPI spec.
// Usage: npm run update-spec
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SPEC_PATH, SPEC_URL } from "./spec-files.mjs";

let response;
try {
  response = await fetch(SPEC_URL);
} catch (error) {
  console.error(`Failed to reach ${SPEC_URL}: ${error.message}`);
  process.exit(1);
}
if (!response.ok) {
  console.error(`Failed to fetch ${SPEC_URL}: ${response.status} ${response.statusText}`);
  process.exit(1);
}
const body = await response.text();

let doc;
try {
  doc = JSON.parse(body);
} catch (error) {
  console.error(`Downloaded document is not valid JSON: ${error.message} — not writing.`);
  process.exit(1);
}
if (!doc || typeof doc.paths !== "object" || doc.paths === null) {
  console.error("Downloaded document has no 'paths' object — not an OpenAPI spec, not writing.");
  process.exit(1);
}

await mkdir(dirname(SPEC_PATH), { recursive: true });
await writeFile(SPEC_PATH, body);
console.log(`Updated ${SPEC_PATH} from ${SPEC_URL} (v3 API ${doc.info?.version}).`);
console.log("Review the diff, then run: npm run gen:params && npm test");
