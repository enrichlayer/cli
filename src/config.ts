import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const VERSION = version;
export const USER_AGENT = `enrichlayer-cli-v3/${version}`;
export const DEFAULT_API_BASE_URL = "https://api.enrichlayer.com";
export const REQUEST_TIMEOUT_MS = 305_000;
export const RETRY_DELAYS_MS = [1_000, 3_000];

export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ENRICHLAYER_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}
