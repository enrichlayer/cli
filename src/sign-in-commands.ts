import { withCredentialLock } from "./auth/lock.js";
import {
  BrowserOpenError,
  browserLogin,
  deviceLogin,
  type LoginMethod,
  loginEnvironment,
  type OAuthConfig,
  type OAuthTokens,
  oauthConfig,
  openBrowser,
  revokeTokens,
  selectLoginMethod,
  tokenIdentity,
} from "./auth/oauth.js";
import { SignInCredentials } from "./auth/sign-in.js";
import type { TokenStore } from "./auth/token-store.js";

/** Everything auth login, auth logout and the sign-in part of auth status touch outside the process. */
export interface SignInDeps {
  env: NodeJS.ProcessEnv;
  store: TokenStore;
  lockDir: string;
  /** A line for stdout. */
  say: (line: string) => void;
  /** A line for stderr: progress, links, codes and warnings. */
  note: (line: string) => void;
  /** Where a key that takes precedence over the sign-in comes from, or null when none does. */
  keyInUse: () => string | null;
  method?: (noBrowser: boolean) => LoginMethod;
  open?: (url: string, windows: boolean) => Promise<void>;
  browser?: typeof browserLogin;
  device?: typeof deviceLogin;
}

function describe(tokens: OAuthTokens): string {
  const { sub, clientId, grantId } = tokenIdentity(tokens);
  return `account ${sub ?? "unknown"}, client ${clientId}, grant ${grantId ?? "unknown"}`;
}

async function deviceFlow(config: OAuthConfig, deps: SignInDeps): Promise<OAuthTokens> {
  return (deps.device ?? deviceLogin)(config, {
    onCode: ({ userCode, verificationUri }) => deps.note(`To sign in, open ${verificationUri} in a browser and enter the code ${userCode}`),
  });
}

export async function login(noBrowser: boolean, deps: SignInDeps): Promise<void> {
  const config = oauthConfig(deps.env);
  const method = (deps.method ?? ((no) => selectLoginMethod(loginEnvironment(no, deps.env))))(noBrowser);
  let tokens: OAuthTokens;
  if (method === "device") tokens = await deviceFlow(config, deps);
  else {
    try {
      tokens = await (deps.browser ?? browserLogin)(config, {
        open: (url) => (deps.open ?? openBrowser)(url, method === "windows"),
        onUrl: (url) => deps.note(`If the browser does not open, or opens the wrong browser or profile, open this link:\n${url}`),
      });
    } catch (error) {
      if (!(error instanceof BrowserOpenError)) throw error;
      deps.note("Could not open a browser. Use this link and code instead.");
      tokens = await deviceFlow(config, deps);
    }
  }
  await withCredentialLock(deps.lockDir, () => deps.store.write(tokens));
  deps.say(`Signed in: ${describe(tokens)}.`);
  const key = deps.keyInUse();
  if (key) deps.say(`${key} takes precedence over the sign-in while it is there.`);
}

export async function logout(deps: SignInDeps): Promise<void> {
  const line = await withCredentialLock(deps.lockDir, async () => {
    const tokens = await deps.store.read();
    if (!tokens) {
      await deps.store.clear();
      return "No stored sign-in.";
    }
    let revoked = false;
    try {
      revoked = await revokeTokens(tokens);
    } finally {
      // The local copy goes whatever the issuer said.
      await deps.store.clear();
    }
    if (!revoked) deps.note(`Warning: ${tokens.issuer} did not confirm that the sign-in was revoked; the local copy is deleted.`);
    return revoked ? "Signed out: the sign-in is revoked and deleted." : "Signed out: the sign-in is deleted.";
  });
  deps.say(line);
}

/**
 * The sign-in line of auth status, or nothing when there is no stored sign-in. Returns whether the
 * sign-in is what calls use. Never prints a token.
 */
export async function signInStatus(deps: SignInDeps): Promise<boolean> {
  if (!(await deps.store.read())) return false;
  let tokens: OAuthTokens;
  try {
    tokens = await new SignInCredentials({ store: deps.store, lockDir: deps.lockDir, config: oauthConfig(deps.env) }).tokens();
  } catch (error) {
    deps.say(`Sign-in: not usable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  const key = deps.keyInUse();
  const use = key ? `not in use: ${key} takes precedence` : "in use";
  deps.say(`Sign-in: ${describe(tokens)}, access token valid until ${new Date(tokens.expiresAt).toISOString()} (${use})`);
  return key === null;
}
