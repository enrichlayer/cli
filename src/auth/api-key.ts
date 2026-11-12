export const DASHBOARD_URL = "https://enrichlayer.com/dashboard";

export type KeySource = "--api-key" | "ENRICHLAYER_API_KEY";

export interface Credentials {
  source: KeySource;
  authorization(): string;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(`No API key. Set ENRICHLAYER_API_KEY or pass --api-key; create a key at ${DASHBOARD_URL}.`);
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

export interface KeyOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
}

export function apiKeyCredentials({ flag, env = process.env }: KeyOptions = {}): Credentials {
  const source: KeySource = flag === undefined ? "ENRICHLAYER_API_KEY" : "--api-key";
  const given = flag ?? env.ENRICHLAYER_API_KEY;
  return {
    source,
    authorization() {
      const key = given?.trim();
      if (!key) throw new MissingApiKeyError();
      if (/[^\x21-\x7e]/.test(key)) throw new InvalidApiKeyError(source);
      return `Bearer ${key}`;
    },
  };
}
