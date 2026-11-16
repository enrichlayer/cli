// The one place that knows about the OS keychain. To use another keychain library, or none, change
// only this file: the store falls back to a private file whenever openKeychain() or an entry throws.

export interface KeychainEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

export interface KeyringModule {
  Entry: new (service: string, account: string, options?: { linux?: { store?: "secret-service" | "keyutils" } }) => KeychainEntry;
}

const SERVICE = "enrichlayer-v3";
const ACCOUNT = "oauth";
// Without a pinned store, Linux without a Secret Service falls back to the kernel session keyring:
// in memory, per session and gone at reboot. Pinned, a missing Secret Service throws instead, and the
// sign-in goes to the private file.
export const ENTRY_OPTIONS = { linux: { store: "secret-service" } } as const;

export async function openKeychain(
  env: NodeJS.ProcessEnv = process.env,
  load: () => Promise<KeyringModule> = () => import("@napi-rs/keyring"),
): Promise<KeychainEntry> {
  // ENRICHLAYER_CREDENTIAL_STORE=file keeps tests and unattended hosts away from the OS keychain.
  if (env.ENRICHLAYER_CREDENTIAL_STORE === "file") throw new Error("The file credential store is selected");
  const { Entry } = await load();
  return new Entry(SERVICE, ACCOUNT, ENTRY_OPTIONS);
}
