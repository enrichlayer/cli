import { keyFilePath, readKeyFile } from "./key-file.js";

export const DASHBOARD_URL = "https://enrichlayer.com/dashboard";

export type KeySource = string;

/** The source of a stored sign-in, as messages and --dry-run name it. */
export const SIGN_IN_SOURCE = "the stored sign-in";

export interface Credentials {
  source: KeySource;
  /** The Authorization header for the next request. */
  authorization(): string | Promise<string>;
  /**
   * After a 401 for the header `rejected`: a fresher header to retry with once, or null when there is
   * none. API keys do not have this.
   */
  refreshAfter401?(rejected: string): Promise<string | null>;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(`No API key. Set ENRICHLAYER_API_KEY, pass --api-key, or save a key with enrichlayer-v3 auth save; create a key at ${DASHBOARD_URL}.`);
    this.name = "MissingApiKeyError";
  }
}

export class InvalidApiKeyError extends Error {
  constructor(readonly source: KeySource) {
    super(
      `The API key from ${source} contains a space, a line break or another character an API key cannot have. Copy the key again from ${DASHBOARD_URL}.`,
    );
    this.name = "InvalidApiKeyError";
  }
}

export class KeyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyFileError";
  }
}

export function isValidKey(key: string): boolean {
  return !/[^\x21-\x7e]/.test(key);
}

function bearer(given: string | undefined, source: KeySource): string {
  const key = given?.trim();
  if (!key) throw new MissingApiKeyError();
  if (!isValidKey(key)) throw new InvalidApiKeyError(source);
  return `Bearer ${key}`;
}

export function isKeyInEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ENRICHLAYER_API_KEY?.trim());
}

export interface KeyOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  file?: string;
}

export function apiKeyCredentials({ flag, env = process.env, file = keyFilePath({ env }) }: KeyOptions = {}): Credentials {
  if (flag !== undefined) return { source: "--api-key", authorization: () => bearer(flag, "--api-key") };
  if (isKeyInEnv(env)) return { source: "ENRICHLAYER_API_KEY", authorization: () => bearer(env.ENRICHLAYER_API_KEY, "ENRICHLAYER_API_KEY") };
  const source = `the key file ${file}`;
  return {
    source,
    authorization() {
      const state = readKeyFile(file);
      if (state.status === "missing") throw new MissingApiKeyError();
      if (state.status === "unusable") throw new KeyFileError(state.message);
      return bearer(state.key, source);
    },
  };
}
