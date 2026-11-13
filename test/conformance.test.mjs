import { runCli, startApi } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandDefs } from "../build/commands.js";
import { buildProgram, commandName, flagFor, optionFor } from "../build/program.js";
import { readSpec } from "../scripts/spec-files.mjs";

const spec = await readSpec();
const program = buildProgram(async () => {});
const COMMON_FLAGS = ["--api-key", "--dry-run"];

const FEWEST_FLAGS = {
  "/v3/person": ["--profile", "jane"],
  "/v3/company": ["--url", "https://www.linkedin.com/company/acme"],
  "/v3/company/search": ["--q", "acme"],
  "/v3/company/logo": ["--q", "acme.com"],
  "/v3/email/prospect": ["--full-name", "Jane Doe", "--domain", "acme.com"],
  "/v3/email/validate": ["--email", "jane@acme.com"],
};

const ONE_OF = { "/v3/person": ["profile", "email", "twitter", "facebook", "github"] };

function specParams(path) {
  const item = spec.paths[path];
  const params = [...(item.parameters ?? []), ...(item.get?.parameters ?? [])];
  for (const param of params) assert.equal(param.$ref, undefined, `${path}: $ref params are not handled by this check`);
  return params.filter((param) => param.in === "query");
}

function isSection(param) {
  const values = param.schema.enum;
  return values !== undefined && [...values].sort().join() === "exclude,include" && param.schema.default === "exclude";
}

function sample(param) {
  const flag = `--${flagFor(param.name)}`;
  if (isSection(param)) return { args: [flag], sent: "include" };
  if (param.schema.enum) return { args: [flag, param.schema.enum[0]], sent: param.schema.enum[0] };
  if (param.schema.type === "integer") {
    const value = String(param.schema.minimum ?? 1);
    return { args: [flag, value], sent: value };
  }
  return { args: [flag, `${param.name}-value`], sent: `${param.name}-value` };
}

function commandFor(path) {
  return program.commands.find((command) => command.name() === commandName(path));
}

async function withApi(t) {
  const api = await startApi(() => ({ body: {} }));
  t.after(api.close);
  return { api, env: { ENRICHLAYER_API_KEY: "test-key", ENRICHLAYER_API_BASE_URL: api.url } };
}

test("flag names are the spec names in words joined by hyphens", () => {
  assert.deepEqual(
    ["maxAgeSeconds", "full_name", "workEmail", "q", "socialLink"].map(flagFor),
    ["max-age-seconds", "full-name", "work-email", "q", "social-link"],
  );
});

test("there is one command for every path of the v3 spec, and no command for a path it does not have", () => {
  const paths = Object.keys(spec.paths).sort();

  assert.deepEqual(commandDefs.map((def) => def.path).sort(), paths);
  assert.deepEqual(
    program.commands.map((command) => command.name()).sort(),
    paths.map((path) => path.slice("/v3/".length).replaceAll("/", "-")).sort(),
  );
  assert.deepEqual(Object.keys(FEWEST_FLAGS).sort(), paths);
});

test("every command has a flag for each spec parameter and no other, required as in the spec", () => {
  for (const path of Object.keys(spec.paths)) {
    const command = commandFor(path);
    const params = specParams(path);
    const flags = command.options.map((option) => option.long);

    assert.deepEqual(
      flags.filter((flag) => !COMMON_FLAGS.includes(flag)).sort(),
      params.map((param) => `--${flagFor(param.name)}`).sort(),
      `${path}: flags`,
    );
    assert.equal(new Set(flags).size, flags.length, `${path}: flag names repeat`);
    for (const param of params) {
      const option = command.options.find((candidate) => candidate.long === `--${flagFor(param.name)}`);
      assert.equal(option.mandatory, param.required === true, `${path} ${param.name}: required`);
      assert.equal(option.isBoolean(), isSection(param), `${path} ${param.name}: section switch`);
      if (param.schema.enum && !isSection(param)) assert.deepEqual(option.argChoices, param.schema.enum, `${path} ${param.name}: allowed values`);
    }
  }
});

test("whole numbers outside the spec bounds are refused before any request, and the bounds pass", async (t) => {
  const { api, env } = await withApi(t);

  for (const path of Object.keys(spec.paths)) {
    for (const param of specParams(path).filter((candidate) => candidate.schema.type === "integer")) {
      const flag = `--${flagFor(param.name)}`;
      const base = [commandName(path), ...FEWEST_FLAGS[path]];
      const { minimum, maximum } = param.schema;

      for (const outside of [minimum === undefined ? undefined : minimum - 1, maximum === undefined ? undefined : maximum + 1]) {
        if (outside === undefined) continue;
        const result = await runCli([...base, flag, String(outside)], { env });
        assert.equal(result.code, 2, `${path} ${param.name}=${outside}: exit code`);
      }
      for (const bound of [minimum, maximum]) {
        if (bound === undefined) continue;
        const result = await runCli([...base, flag, String(bound), "--dry-run"], { env });
        assert.equal(result.code, 0, `${path} ${param.name}=${bound}: exit code`);
        assert.equal(new URL(JSON.parse(result.stdout).url).searchParams.get(param.name), String(bound));
      }
    }
  }
  assert.equal(api.requests.length, 0);
});

test("a command sends every given parameter under its spec name, and nothing else", async (t) => {
  const { api, env } = await withApi(t);

  for (const path of Object.keys(spec.paths)) {
    const params = specParams(path);
    const oneOf = ONE_OF[path] ?? [undefined];
    const sentNames = new Set();

    for (const chosen of oneOf) {
      const given = params.filter((param) => !ONE_OF[path]?.includes(param.name) || param.name === chosen);
      const samples = given.map((param) => [param.name, sample(param)]);
      const result = await runCli([commandName(path), ...samples.flatMap(([, { args }]) => args)], { env });
      const request = api.requests.at(-1);

      assert.equal(result.code, 0, `${path}: exit code, stderr ${result.stderr}`);
      assert.equal(request.method, "GET");
      assert.equal(request.path, path);
      assert.deepEqual(request.query, Object.fromEntries(samples.map(([name, { sent }]) => [name, sent])), `${path}: query`);
      for (const name of Object.keys(request.query)) sentNames.add(name);
    }
    assert.deepEqual([...sentNames].sort(), params.map((param) => param.name).sort(), `${path}: every parameter sent`);
  }
});

test("a command with the fewest flags sends only them", async (t) => {
  const { api, env } = await withApi(t);

  for (const [path, args] of Object.entries(FEWEST_FLAGS)) {
    await runCli([commandName(path), ...args], { env });

    const expected = {};
    for (let index = 0; index < args.length; index += 2) {
      const param = specParams(path).find((candidate) => `--${flagFor(candidate.name)}` === args[index]);
      expected[param.name] = args[index + 1];
    }
    assert.deepEqual(api.requests.at(-1).query, expected, `${path}: query`);
  }
});

test("a parameter type the CLI cannot parse stops building the commands", () => {
  assert.throws(() => optionFor("/v3/example", { name: "isActive", required: false, type: "boolean" }), {
    message: "/v3/example isActive: unsupported parameter type boolean",
  });
});
