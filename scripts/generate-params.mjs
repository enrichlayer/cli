// Write the command parameters from the copy of the v3 spec.
// Usage: npm run gen:params
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { renderParams } from "./params-source.mjs";
import { GENERATED_PATH, readSpec } from "./spec-files.mjs";

await mkdir(dirname(GENERATED_PATH), { recursive: true });
await writeFile(GENERATED_PATH, renderParams(await readSpec()));
console.log(`Wrote ${GENERATED_PATH}`);
