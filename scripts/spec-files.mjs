import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SPEC_URL = "https://enrichlayer.com/docs/api/v3/openapi.json";
export const SPEC_PATH = resolve(ROOT, "spec/v3-openapi.json");
export const GENERATED_PATH = resolve(ROOT, "src/generated/v3-params.ts");

export async function readSpec() {
  return JSON.parse(await readFile(SPEC_PATH, "utf8"));
}
