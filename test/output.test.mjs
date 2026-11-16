import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, toYaml } from "../build/output.js";

const ESC = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const DEL = String.fromCharCode(0x7f);
const NEL = String.fromCharCode(0x85);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const REPLACEMENT = String.fromCharCode(0xfffd);
const BACKSLASH = String.fromCharCode(92);
const u = (code) => `${BACKSLASH}u${code.toString(16).padStart(4, "0")}`;

const PERSON = {
  fullName: "Jane Example",
  middleName: null,
  isPublic: true,
  followers: 1200,
  location: { city: "Seattle", country: "US" },
  interests: ["chess", "sailing"],
  certifications: [],
  experience: { work: [{ title: "CTO", company: { name: "Acme" } }, { title: "Engineer", company: { name: "Initech" } }] },
  education: [{ school: "MIT" }],
  extra: {},
};

const result = (data, creditCost = 1, requestId = "req-1") => ({ data, creditCost, requestId });

test("json is indented in a terminal and one line otherwise; jsonl is always one line", () => {
  const answer = result({ fullName: "Jane" });

  assert.equal(render({ result: answer, format: "json", isTerminal: true }).stdout, `${JSON.stringify(answer, null, 2)}\n`);
  assert.equal(render({ result: answer, format: "json", isTerminal: false }).stdout, `${JSON.stringify(answer)}\n`);
  assert.deepEqual(render({ result: answer, format: "jsonl", isTerminal: true }), { stdout: `${JSON.stringify(answer)}\n`, notes: [] });
});

test("a table of one answer lists every plain field, leaves out lists of objects and says so", () => {
  const rendered = render({ result: result(PERSON), format: "table", isTerminal: true });

  assert.deepEqual(rendered, {
    stdout: [
      "fullName          Jane Example",
      "middleName",
      "isPublic          true",
      "followers         1200",
      "location.city     Seattle",
      "location.country  US",
      'interests         ["chess","sailing"]',
      "certifications    []",
      "extra             {}",
      "",
    ].join("\n"),
    notes: [
      "Lists left out: experience.work (2 items), education (1 item); name them in --fields to show them.",
      "credits charged: 1, request id: req-1",
    ],
  });
});

test("a table of a list has a column per field and a line per item", () => {
  const companies = [
    { companyName: "Acme", domain: { resolved: "acme.com" }, employeeCount: 12 },
    { companyName: "Initech Corporation", domain: { resolved: "initech.com" }, employeeCount: null },
  ];

  const rendered = render({ result: result(companies, 0, "req-2"), format: "table", isTerminal: true });

  assert.deepEqual(rendered, {
    stdout: [
      "companyName          domain.resolved  employeeCount",
      "Acme                 acme.com         12",
      "Initech Corporation  initech.com",
      "",
    ].join("\n"),
    notes: ["credits charged: 0, request id: req-2"],
  });
});

test("--fields picks columns in the given order, expands a named list and leaves an unknown field empty", () => {
  const rendered = render({
    result: result(PERSON),
    format: "csv",
    fields: ["fullName", "experience.work", "education.0.school", "nickname"],
    isTerminal: false,
  });

  assert.deepEqual(rendered, {
    stdout: [
      "fullName,experience.work.0.title,experience.work.0.company.name,experience.work.1.title,experience.work.1.company.name,education.0.school,nickname",
      "Jane Example,CTO,Acme,Engineer,Initech,MIT,",
      "",
    ].join("\r\n"),
    notes: ["credits charged: 1, request id: req-1"],
  });
});

test("work email candidates are the rows, with the name on each of them", () => {
  const prospect = { name: "Jane Example", emails: [{ email: "jane@acme.com", validity: "valid" }, { email: "j@acme.com", validity: "catchall" }] };

  const rendered = render({ result: result(prospect), format: "csv", rowsPath: "emails", isTerminal: false });

  assert.equal(rendered.stdout, ["name,email,validity", "Jane Example,jane@acme.com,valid", "Jane Example,j@acme.com,catchall", ""].join("\r\n"));
});

test("an empty list prints nothing to stdout and still reports the cost", () => {
  assert.deepEqual(render({ result: result([], 0, "req-3"), format: "csv", isTerminal: false }), {
    stdout: "",
    notes: ["credits charged: 0, request id: req-3"],
  });
  assert.equal(render({ result: result({ name: "Jane", emails: [] }), format: "table", rowsPath: "emails", isTerminal: true }).stdout, "");
});

test("csv quotes what needs quotes, keeps line breaks inside them and uses CRLF between records", () => {
  const rendered = render({
    result: result([{ about: 'Says "hi", then\nleaves', padded: " x ", plain: "ok" }]),
    format: "csv",
    isTerminal: false,
  });

  assert.equal(rendered.stdout, `about,padded,plain\r\n"Says ""hi"", then\nleaves"," x ",ok\r\n`);
});

test("csv puts an apostrophe before text that a spreadsheet would run as a formula, and leaves numbers alone", () => {
  const rendered = render({
    result: result([{ a: "=1+2", b: "+1 425 555 0100", c: "-x", d: "@SUM(A1)", e: "\tx", f: "\rx", g: -5, h: "a=b" }]),
    format: "csv",
    isTerminal: false,
  });

  assert.equal(rendered.stdout, `a,b,c,d,e,f,g,h\r\n'=1+2,'+1 425 555 0100,'-x,'@SUM(A1),'\tx,"'\rx",-5,a=b\r\n`);
});

test("control characters cannot reach the terminal through a table or a csv", () => {
  const hostile = { name: `Jane${ESC}[2J${ESC}]0;title${BELL}`, note: `a${DEL}b${String.fromCharCode(0x9b)}c\td\ne` };

  const table = render({ result: result(hostile), format: "table", isTerminal: true }).stdout;
  const csv = render({ result: result([hostile]), format: "csv", isTerminal: false }).stdout;

  assert.equal(table, `name  Jane${REPLACEMENT}[2J${REPLACEMENT}]0;title${REPLACEMENT}\nnote  a${REPLACEMENT}b${REPLACEMENT}c d e\n`);
  assert.equal(csv, `name,note\r\nJane${REPLACEMENT}[2J${REPLACEMENT}]0;title${REPLACEMENT},"a${REPLACEMENT}b${REPLACEMENT}c\td\ne"\r\n`);
});

test("yaml writes the whole answer, every string in double quotes", () => {
  const yaml = toYaml({
    data: { fullName: "Jane", middleName: null, isPublic: true, followers: 1200, interests: ["chess"], certifications: [], extra: {}, experience: [{ title: "CTO", tags: ["a", "b"] }, { nested: [[1, 2]] }] },
    numbers: [1e21, 1e-7, 1.5e21, -0.5],
    creditCost: 1,
    requestId: "req-1",
  });

  assert.equal(
    yaml,
    [
      "data:",
      '  fullName: "Jane"',
      "  middleName: null",
      "  isPublic: true",
      "  followers: 1200",
      "  interests:",
      '    - "chess"',
      "  certifications: []",
      "  extra: {}",
      "  experience:",
      '    - title: "CTO"',
      "      tags:",
      '        - "a"',
      '        - "b"',
      "    - nested:",
      "        - - 1",
      "          - 2",
      "numbers:",
      "  - 1.0e+21",
      "  - 1.0e-7",
      "  - 1.5e+21",
      "  - -0.5",
      "creditCost: 1",
      'requestId: "req-1"',
      "",
    ].join("\n"),
  );
});

test("yaml escapes what YAML parsers would read as a line break or reject, and quotes keys YAML 1.1 reads as words", () => {
  const yaml = toYaml({
    text: `a${NEL}b${LINE_SEPARATOR}c${String.fromCharCode(0x2029)}d${DEL}e${String.fromCharCode(0x9f)}f"g\nh`,
    yes: 1,
    No: 2,
    on: 3,
    Y: 4,
    NULL: 5,
    "a-b": 6,
    "1x": 7,
    ok_key: 8,
  });

  assert.equal(
    yaml,
    [
      `text: "a${u(0x85)}b${u(0x2028)}c${u(0x2029)}d${u(0x7f)}e${u(0x9f)}f${BACKSLASH}"g${BACKSLASH}nh"`,
      '"yes": 1',
      '"No": 2',
      '"on": 3',
      '"Y": 4',
      '"NULL": 5',
      '"a-b": 6',
      '"1x": 7',
      "ok_key: 8",
      "",
    ].join("\n"),
  );
});

test("no format writes [object Object] for nested answers", () => {
  const answers = [
    { data: PERSON },
    { data: [{ companyName: "Acme", location: { city: "Austin" }, tags: [{ a: 1 }] }] },
    { data: { name: "Jane", emails: [{ email: "jane@acme.com", mxRecords: ["mx.acme.com"] }] }, rowsPath: "emails" },
  ];

  for (const { data, rowsPath } of answers) {
    for (const format of ["json", "table", "csv", "yaml", "jsonl"]) {
      const { stdout } = render({ result: result(data), format, rowsPath, isTerminal: false });
      assert.equal(stdout.includes("[object Object]"), false, format);
    }
    const expanded = render({ result: result(data), format: "table", fields: ["experience", "tags", "emails"], rowsPath, isTerminal: false });
    assert.equal(expanded.stdout.includes("[object Object]"), false);
  }
});

test("json and jsonl escape line separators and C1 controls, and still read back the same answer", () => {
  const answer = result({ name: `Ann${LINE_SEPARATOR}Lee`, headline: `next${NEL}line`, del: `a${DEL}b`, csi: `x${String.fromCharCode(0x9b)}31m`, end: String.fromCharCode(0x2029) });
  const raw = /[\x7f-\x9f]/;

  for (const [format, isTerminal] of [["json", false], ["json", true], ["jsonl", true]]) {
    const { stdout } = render({ result: answer, format, isTerminal });
    const lines = stdout.replace(/\n$/, "").split(/\r?\n|\r/);

    assert.deepEqual(JSON.parse(stdout), answer, format);
    assert.equal(raw.test(stdout) || stdout.includes(LINE_SEPARATOR) || stdout.includes(String.fromCharCode(0x2029)), false, format);
    if (!isTerminal || format === "jsonl") assert.equal(lines.length, 1, format);
    assert.equal(stdout.includes(`${BACKSLASH}u2028`) && stdout.includes(`${BACKSLASH}u0085`) && stdout.includes(`${BACKSLASH}u009b`), true, format);
  }
});

test("a table turns the Unicode line breaks into spaces", () => {
  const rendered = render({
    result: result({ note: `a${LINE_SEPARATOR}b${String.fromCharCode(0x2029)}c${NEL}d` }),
    format: "table",
    isTerminal: true,
  });

  assert.equal(rendered.stdout, "note  a b c d\n");
});

test("--fields through a list without an index takes the field from every item", () => {
  const answer = {
    experience: { work: [{ title: "CEO", company: { name: "Acme" } }, { company: { name: "Initech" } }] },
    education: [],
  };

  const rendered = render({
    result: result(answer),
    format: "csv",
    fields: ["experience.work.title", "experience.work.company.name", "experience.work.5.title", "education.school"],
    isTerminal: false,
  });

  assert.equal(
    rendered.stdout,
    [
      "experience.work.0.title,experience.work.1.title,experience.work.0.company.name,experience.work.1.company.name,experience.work.5.title,education.school",
      "CEO,,Acme,Initech,,",
      "",
    ].join("\r\n"),
  );
});
