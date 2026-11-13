import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderParams } from "../scripts/params-source.mjs";
import { GENERATED_PATH, readSpec } from "../scripts/spec-files.mjs";

test("src/generated/v3-params.ts is generated from the current spec/v3-openapi.json", async () => {
  const committed = await readFile(GENERATED_PATH, "utf8");
  assert.equal(committed, renderParams(await readSpec()), "run `npm run gen:params` and commit the result");
});

test("renderParams leaves out the API's rule for several identifiers", () => {
  const rule = "If several identifiers are given, only the first in the order github, email, profile, facebook, twitter is used";
  const spec = {
    info: { version: "0" },
    paths: {
      "/v3/person": {
        get: {
          parameters: [
            { name: "email", in: "query", schema: { type: "string" }, description: `Email address. ${rule}` },
            { name: "profile", in: "query", schema: { type: "string" }, description: `LinkedIn username or profile URL. ${rule}.` },
          ],
        },
      },
    },
  };
  const described = renderParams(spec).split("\n").filter((line) => line.includes('"description"'));
  assert.deepEqual(described, [
    '    {"name":"email","required":false,"type":"string","description":"Email address."},',
    '    {"name":"profile","required":false,"type":"string","description":"LinkedIn username or profile URL."},',
  ]);
});
