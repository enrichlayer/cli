import { tempDir } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiKeyCredentials } from "../build/auth/api-key.js";
import { keyFilePath, readKeyFile, removeKeyFile, saveKeyFile } from "../build/auth/key-file.js";

const BACKSLASH = String.fromCharCode(92);
const modeOf = (path) => statSync(path).mode & 0o777;

function keyFile(t) {
  const folder = join(tempDir(t), "enrichlayer-v3");
  return { folder, file: join(folder, "credentials.json") };
}

test("the key file lives under XDG_CONFIG_HOME, else ~/.config, and under APPDATA on Windows", () => {
  const windows = (...parts) => parts.join(BACKSLASH);

  assert.equal(keyFilePath({ platform: "linux", env: { XDG_CONFIG_HOME: "/x/config" }, home: "/home/jane" }), "/x/config/enrichlayer-v3/credentials.json");
  assert.equal(keyFilePath({ platform: "darwin", env: {}, home: "/Users/jane" }), "/Users/jane/.config/enrichlayer-v3/credentials.json");
  assert.equal(keyFilePath({ platform: "linux", env: { XDG_CONFIG_HOME: "config" }, home: "/home/jane" }), "/home/jane/.config/enrichlayer-v3/credentials.json");
  assert.equal(
    keyFilePath({ platform: "win32", env: { APPDATA: windows("C:", "Users", "jane", "AppData", "Roaming") }, home: windows("C:", "Users", "jane") }),
    windows("C:", "Users", "jane", "AppData", "Roaming", "enrichlayer-v3", "credentials.json"),
  );
  assert.equal(
    keyFilePath({ platform: "win32", env: {}, home: windows("C:", "Users", "jane") }),
    windows("C:", "Users", "jane", "AppData", "Roaming", "enrichlayer-v3", "credentials.json"),
  );
});

test("saving writes the key with mode 0600 into a folder with mode 0700 and leaves no temporary file", (t) => {
  const { folder, file } = keyFile(t);
  mkdirSync(folder, { recursive: true });
  chmodSync(folder, 0o755);
  writeFileSync(file, "old", { mode: 0o644 });

  saveKeyFile(file, "sk-test-123");

  assert.equal(readFileSync(file, "utf8"), '{"apiKey":"sk-test-123"}\n');
  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(folder), 0o700);
  assert.deepEqual(readdirSync(folder), ["credentials.json"]);
});

test("saving over a link replaces the link with a file and leaves the target alone", (t) => {
  const { folder, file } = keyFile(t);
  mkdirSync(folder, { recursive: true });
  const target = join(folder, "..", "elsewhere.json");
  writeFileSync(target, "untouched");
  symlinkSync(target, file);

  saveKeyFile(file, "sk-test-123");

  assert.equal(lstatSync(file).isSymbolicLink(), false);
  assert.equal(readFileSync(target, "utf8"), "untouched");
  assert.deepEqual(readKeyFile(file), { status: "saved", key: "sk-test-123" });
});

test("reading tells a missing, a saved and an unusable key file apart", (t) => {
  const { folder, file } = keyFile(t);
  assert.deepEqual(readKeyFile(file), { status: "missing" });

  saveKeyFile(file, "sk-test-123");
  assert.deepEqual(readKeyFile(file), { status: "saved", key: "sk-test-123" });

  chmodSync(file, 0o644);
  assert.deepEqual(readKeyFile(file), {
    status: "unusable",
    reason: "readable by other users, mode 0644",
    message: `The key file ${file} can be read by other users (mode 0644). Run chmod 600 ${file}, or save the key again with enrichlayer-v3 auth save.`,
  });
  assert.equal(readKeyFile(file, "win32").status, "saved");

  for (const content of ["{not json", '{"apiKey":""}', '{"key":"sk-test-123"}', "null"]) {
    writeFileSync(file, content, { mode: 0o600 });
    chmodSync(file, 0o600);
    assert.deepEqual(readKeyFile(file), {
      status: "unusable",
      reason: "not valid",
      message: `The key file ${file} is not valid. Save the key again with enrichlayer-v3 auth save, or remove it with enrichlayer-v3 auth remove.`,
    }, content);
  }

  const notRegular = {
    status: "unusable",
    reason: "not a regular file",
    message: `The key file ${file} is not a regular file. Remove it and save the key again with enrichlayer-v3 auth save.`,
  };
  removeKeyFile(file);
  const target = join(folder, "target.json");
  writeFileSync(target, '{"apiKey":"sk-test-123"}', { mode: 0o600 });
  symlinkSync(target, file);
  assert.deepEqual(readKeyFile(file), notRegular);
  removeKeyFile(file);
  mkdirSync(file);
  assert.deepEqual(readKeyFile(file), notRegular);
});

test("removing deletes the file, reports a missing one, and removes a link without its target", (t) => {
  const { folder, file } = keyFile(t);
  saveKeyFile(file, "sk-test-123");

  assert.equal(removeKeyFile(file), true);
  assert.equal(removeKeyFile(file), false);

  const target = join(folder, "target.json");
  writeFileSync(target, "kept");
  symlinkSync(target, file);
  assert.equal(removeKeyFile(file), true);
  assert.equal(readFileSync(target, "utf8"), "kept");
});

test("the key comes from --api-key, then a non-empty ENRICHLAYER_API_KEY, then the key file", (t) => {
  const { file } = keyFile(t);
  saveKeyFile(file, "file-key");
  const env = { ENRICHLAYER_API_KEY: "env-key" };
  const used = (options) => {
    const credentials = apiKeyCredentials({ file, ...options });
    return [credentials.source, credentials.authorization()];
  };

  assert.deepEqual(used({ flag: "flag-key", env }), ["--api-key", "Bearer flag-key"]);
  assert.deepEqual(used({ env }), ["ENRICHLAYER_API_KEY", "Bearer env-key"]);
  assert.deepEqual(used({ env: {} }), [`the key file ${file}`, "Bearer file-key"]);
  assert.deepEqual(used({ env: { ENRICHLAYER_API_KEY: "" } }), [`the key file ${file}`, "Bearer file-key"]);
  assert.deepEqual(used({ env: { ENRICHLAYER_API_KEY: "  \n" } }), [`the key file ${file}`, "Bearer file-key"]);
});

test("a key file problem fails with its own text, and a broken file does not matter while the variable is set", (t) => {
  const { file } = keyFile(t);
  saveKeyFile(file, "file-key");
  chmodSync(file, 0o640);

  assert.throws(() => apiKeyCredentials({ file, env: {} }).authorization(), {
    name: "KeyFileError",
    message: `The key file ${file} can be read by other users (mode 0640). Run chmod 600 ${file}, or save the key again with enrichlayer-v3 auth save.`,
  });
  assert.equal(apiKeyCredentials({ file, env: { ENRICHLAYER_API_KEY: "env-key" } }).authorization(), "Bearer env-key");

  removeKeyFile(file);
  assert.throws(() => apiKeyCredentials({ file, env: {} }).authorization(), { name: "MissingApiKeyError" });

  saveKeyFile(file, "bad key");
  assert.throws(() => apiKeyCredentials({ file, env: {} }).authorization(), {
    name: "InvalidApiKeyError",
    message: `The API key from the key file ${file} contains a space, a line break or another character an API key cannot have. Copy the key again from https://enrichlayer.com/dashboard.`,
  });
});
