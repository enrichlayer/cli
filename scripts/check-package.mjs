// Pack the CLI, install the archive into a temporary folder and run it the way a user would.
// Usage: npm run check:package
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { name, version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "enrichlayer-cli-package-"));
const home = join(work, "home");
mkdirSync(home);
const npmEnv = { ...process.env, npm_config_cache: join(work, "npm-cache"), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
const cliEnv = { PATH: process.env.PATH, HOME: home, ENRICHLAYER_API_KEY: "check-package-key" };

const failures = [];
const check = (label, isOk, detail) => {
  console.log(`${isOk ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!isOk) failures.push(label);
};
const run = (command, args, options) => spawnSync(command, args, { encoding: "utf8", ...options });

try {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, env: npmEnv, stdio: "ignore" });
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: ROOT, env: npmEnv, encoding: "utf8" }));
  const tarball = join(work, packed.filename);
  const files = packed.files.map((file) => file.path).sort();

  const outside = files.filter((file) => !file.startsWith("build/") && !["LICENSE", "README.md", "package.json"].includes(file));
  const stale = files.filter((file) => file.startsWith("build/") && !existsSync(join(ROOT, "src", file.slice("build/".length).replace(/\.js(\.map)?$/, ".ts"))));
  check("the archive holds the build, README.md, LICENSE and package.json only", outside.length === 0 && files.includes("build/cli.js"), outside.join(", "));
  check("every built file comes from a file in src/", stale.length === 0, stale.join(", "));
  check(`the archive is ${name}@${version}`, packed.name === name && packed.version === version, `${packed.name}@${packed.version}, ${files.length} files, ${packed.size} bytes`);

  const prefix = join(work, "install");
  execFileSync("npm", ["install", "--prefix", prefix, "--omit=dev", tarball], { env: npmEnv, stdio: "ignore" });
  const bin = join(prefix, "node_modules", ".bin", "enrichlayer-v3");

  const shown = run(bin, ["--version"], { env: cliEnv, cwd: work });
  check("the installed enrichlayer-v3 prints the package version", shown.status === 0 && shown.stdout === `${version}\n`, shown.stdout.trim() || shown.stderr.trim());

  const dryRun = run(bin, ["company-search", "--q", "acme", "--dry-run"], { env: cliEnv, cwd: work });
  let request = {};
  try {
    request = JSON.parse(dryRun.stdout);
  } catch {
    request = {};
  }
  check(
    "a --dry-run of the installed CLI prints the request with this version",
    dryRun.status === 0 && request.headers?.["User-Agent"] === `enrichlayer-cli-v3/${version}` && request.headers?.Authorization === "Bearer <ENRICHLAYER_API_KEY>",
    dryRun.status === 0 ? request.url : dryRun.stderr.trim(),
  );

  const viaNpx = run("npx", ["--yes", `./${packed.filename}`, "--version"], { env: { ...npmEnv, HOME: home }, cwd: work });
  check("npx finds the one command in the archive", viaNpx.status === 0 && viaNpx.stdout === `${version}\n`, viaNpx.stdout.trim() || viaNpx.stderr.trim());
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("The package installs and runs.");
