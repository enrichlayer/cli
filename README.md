# Enrich Layer v3 CLI

Command-line client for the Enrich Layer v3 API: person and company profiles, company search and logos, work email search and email validation. It is a separate tool from the v2 CLI (`el`).

## Install

It needs Node.js 20.3 or newer. Run it without installing:

```sh
npx @enrichlayer/cli-v3 --help
```

or install the `enrichlayer-v3` command:

```sh
npm install -g @enrichlayer/cli-v3
enrichlayer-v3 --help
```

## API key

Create an API key at https://enrichlayer.com/dashboard. The CLI takes the key from, in this order:

1. `--api-key <key>` on the command;
2. the `ENRICHLAYER_API_KEY` environment variable, when it is not empty;
3. the key file saved with `enrichlayer-v3 auth save` (see [Saving the key](#saving-the-key)).

```sh
export ENRICHLAYER_API_KEY=<your key>
```

A key on the command line stays in the shell history and is visible in the list of processes, so prefer the variable or the key file.

## Commands

| Command | Endpoint | Flags |
|---|---|---|
| `person` | `GET /v3/person` | exactly one of `--profile`, `--email`, `--twitter`, `--facebook`, `--github`; sections `--social-link`, `--phone-number`, `--personal-email`, `--work-email`, `--career-insight`, `--developer-profile`, `--activities`; `--max-age-seconds` |
| `company` | `GET /v3/company` | `--url` (required); sections `--funding-data`, `--exit-data`, `--acquisitions`, `--extra`, `--activities`; `--max-age-seconds` |
| `company-search` | `GET /v3/company/search` | `--q` (required) |
| `company-logo` | `GET /v3/company/logo` | `--q` (required) |
| `email-prospect` | `GET /v3/email/prospect` | `--full-name`, or `--first-name` and/or `--last-name`, together with `--domain`; `--limit` (1–10) |
| `email-validate` | `GET /v3/email/validate` | `--email` (required) |

Every flag is the API parameter in words joined by hyphens: `maxAgeSeconds` is `--max-age-seconds`, `full_name` is `--full-name`. A section flag takes no value: `--work-email` sends `workEmail=include`, and without it the API leaves the section out. `enrichlayer-v3 <command> --help` describes every flag.

```sh
enrichlayer-v3 person --profile williamhgates --work-email
enrichlayer-v3 company --url https://www.linkedin.com/company/microsoft --funding-data
enrichlayer-v3 company-search --q microsoft
enrichlayer-v3 email-prospect --full-name "Satya Nadella" --domain microsoft.com
enrichlayer-v3 email-validate --email jane@example.com
```

## Output

A successful call prints `{data, creditCost, requestId}`: `data` is the full v3 answer, `creditCost` the credits charged for the call, and `requestId` the id to quote to support. An error prints one line to stderr that starts with `error:`, with the credits charged and the request id when the API answered; stdout stays empty.

`--format` picks how the answer is printed:

| Format | What stdout gets |
|---|---|
| `json` (default) | the whole answer with `creditCost` and `requestId`; indented in a terminal, one line when the output goes to another program or to a file |
| `jsonl` | the same, always on one line, so `>> calls.jsonl` collects calls in one file |
| `yaml` | the same, as YAML |
| `table` | the answer as a table |
| `csv` | the answer as CSV (RFC 4180, with CR LF between records) |

```sh
enrichlayer-v3 company-search --q microsoft --format table
enrichlayer-v3 person --profile williamhgates --format yaml
enrichlayer-v3 person --profile williamhgates --format jsonl >> people.jsonl
enrichlayer-v3 person --profile williamhgates --format csv --fields fullName,headline,location.city,experience.work.title
```

### Tables and CSV

- A list answer (`company-search`, `company-logo`) has a row per match, work email candidates (`email-prospect`) have a row each with the name repeated, and any other answer is one row. A table of one row lists one field per line.
- Nested objects become dotted columns such as `location.city`. A list of plain values stays in one cell as JSON, such as `["a","b"]`.
- Lists of objects, such as `experience.work` or `education`, are left out, and a line on stderr names them with their sizes. `--fields` shows them: each item gets its number in the path, as in `experience.work.0.title`, and a path through a list without a number, such as `experience.work.title`, takes the field from every item.
- `--fields` takes paths separated by commas and picks the columns in that order. A field the answer does not have gives an empty column. `--fields` works only with `table` and `csv`; `json`, `yaml` and `jsonl` always print the whole answer.
- The credits charged and the request id go to stderr as `credits charged: 1, request id: …`, so stdout holds only the table or the CSV.
- In CSV, a text value that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is written with an apostrophe in front, so that a spreadsheet does not run it as a formula: `+1 425 555 0100` is written as `'+1 425 555 0100`.
- Control characters in the answer, which could act on a terminal, are replaced with the replacement character (U+FFFD) in tables and CSV. Tables also turn line breaks into spaces.

## Saving the key

`auth save` reads the key from stdin and saves it in the key file, `auth status` shows which key is in use and where the key file is, and `auth remove` deletes the key file. None of them prints the key.

```sh
enrichlayer-v3 auth save < key.txt
enrichlayer-v3 auth status
enrichlayer-v3 auth remove
```

To save a key you copied from the dashboard, pipe the clipboard in:

- macOS: `pbpaste | enrichlayer-v3 auth save`
- Linux: `xclip -selection clipboard -o | enrichlayer-v3 auth save`, or `wl-paste | enrichlayer-v3 auth save` on Wayland
- Windows, in PowerShell: `Get-Clipboard | enrichlayer-v3 auth save`

`auth save` does not read the key from the keyboard: with a terminal on stdin it stops and asks to pipe the key in. It does not call the API either; the first call tells whether the key works.

The key file is `credentials.json` in `$XDG_CONFIG_HOME/enrichlayer-v3` when `XDG_CONFIG_HOME` is set, otherwise in `~/.config/enrichlayer-v3` on macOS and Linux and in `%APPDATA%\enrichlayer-v3` on Windows. It is written with mode 0600 in a folder with mode 0700. A call stops with exit code 3 when other users can read the key file, when a link or a folder is in its place, or when it is not valid; the error says how to fix it.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the answer arrived, or `--dry-run` passed |
| 1 | unexpected error |
| 2 | wrong flags or values, including a request the API rejected as invalid (400) |
| 3 | API key or account: no key, a malformed key, a key file that cannot be used, a rejected key (401), access denied or not enough credits (403) |
| 4 | not found (404) |
| 5 | not now: no fresh enough copy (409), rate limit (429), the API unavailable (5xx) or not reachable |
| 6 | the answer did not arrive (timeout or a broken connection); the call may still be charged |
| 130 | stopped with Ctrl-C |

## Dry run

`--dry-run` makes every check of a real call, the API key included, and prints the request as JSON instead of sending it, so nothing is charged. The key itself is not printed: the `Authorization` header shows where it came from.

```sh
enrichlayer-v3 person --profile williamhgates --dry-run
```

## Long calls

`person` and `company` answer from a cached copy no older than `--max-age-seconds` (30 days by default), usually within seconds. A small value starts a live lookup, which is slower, costs more and can take up to 5 minutes. In a terminal, a line on stderr shows how long the call has been waiting.

Ctrl-C stops waiting and exits with 130. The CLI stops waiting by itself after about 5 minutes and exits with 6. In both cases the call may still be charged: to get the copy that was saved in the meantime, run the same command without `--max-age-seconds` instead of repeating a live lookup.

A call is retried only when the API answers 429 or 5xx, at most twice, and never after a timeout or a broken connection.

## Environment

| Variable | Use |
|---|---|
| `ENRICHLAYER_API_KEY` | the API key, when `--api-key` is not given; an empty value counts as unset |
| `ENRICHLAYER_API_BASE_URL` | the API host, `https://api.enrichlayer.com` by default |
| `XDG_CONFIG_HOME` | where the key file is kept, see [Saving the key](#saving-the-key) |

## Development

Build and run from a clone:

```sh
git clone https://github.com/enrichlayer/cli.git
cd cli
npm ci
npm run build
node build/cli.js --help
```

The command flags come from a copy of the published v3 spec in `spec/v3-openapi.json`.

```sh
npm run update-spec                     # refresh the copy from the published spec
npm run gen:params                      # regenerate src/generated/v3-params.ts
npm test                                # build and run the tests
node scripts/check-published-spec.mjs   # compare the copy with the published spec
npm run check:package                   # pack, install the archive in a temporary folder and run it
```

The examples in this README are tests: `test/readme.test.mjs` runs every `enrichlayer-v3` line of the `sh` blocks, in order, against a local stand-in for the API.

CI runs the type check and the tests on Node.js 20, 22 and 24, checks the package, and compares the copy with the published spec on every change and every night.

## License

MIT
