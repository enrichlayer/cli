import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const testHome = mkdtempSync(join(tmpdir(), "enrichlayer-cli-test-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.XDG_CONFIG_HOME = join(testHome, "xdg");
process.env.APPDATA = join(testHome, "appdata");
for (const name of Object.keys(process.env)) if (name.startsWith("ENRICHLAYER_")) delete process.env[name];
process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));
