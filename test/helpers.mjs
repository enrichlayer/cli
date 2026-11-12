import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "enrichlayer-cli-test-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.XDG_CONFIG_HOME;
for (const name of Object.keys(process.env)) if (name.startsWith("ENRICHLAYER_")) delete process.env[name];
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
