// Fail when the published v3 spec differs from the copy in spec/v3-openapi.json.
// Usage: node scripts/check-published-spec.mjs
import { readFile } from "node:fs/promises";
import { queryParams } from "./params-source.mjs";
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
const published = await response.text();
const copy = await readFile(SPEC_PATH, "utf8");

if (published === copy) {
  console.log(`spec/v3-openapi.json matches the published v3 spec (${JSON.parse(copy).info?.version}).`);
  process.exit(0);
}

const before = JSON.parse(copy);
const after = JSON.parse(published);
const changes = [];
if (before.info?.version !== after.info?.version) changes.push(`version ${before.info?.version} → ${after.info?.version}`);
for (const path of Object.keys(after.paths)) if (!before.paths[path]) changes.push(`new path ${path}`);
for (const path of Object.keys(before.paths)) {
  if (!after.paths[path]) {
    changes.push(`removed path ${path}`);
    continue;
  }
  const old = new Map(queryParams(before, path).map((param) => [param.name, JSON.stringify(param)]));
  const now = new Map(queryParams(after, path).map((param) => [param.name, JSON.stringify(param)]));
  for (const name of now.keys()) if (!old.has(name)) changes.push(`${path}: new param ${name}`);
  for (const [name, value] of old) {
    if (!now.has(name)) changes.push(`${path}: removed param ${name}`);
    else if (now.get(name) !== value) changes.push(`${path}: param ${name} changed`);
  }
}
if (changes.length === 0) changes.push("responses, descriptions or formatting only");

console.error(`The published v3 spec differs from spec/v3-openapi.json:\n${changes.map((change) => `  - ${change}`).join("\n")}`);
console.error("Run `npm run update-spec && npm run gen:params`, then `npm test`, and commit the result.");
process.exit(1);
