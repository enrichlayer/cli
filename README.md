# Enrich Layer v3 CLI

Command-line client for the Enrich Layer v3 API: person and company profiles, company search and logos, work email search and email validation. It is a separate tool from the v2 CLI (`el`).

## Requirements

Node.js 20.3 or newer.

## Run from a clone

```sh
npm ci
npm run build
node build/cli.js --help
```

## API key

Create an API key at https://enrichlayer.com/dashboard and put it in the environment:

```sh
export ENRICHLAYER_API_KEY=<your key>
```

`--api-key <key>` on a command takes precedence over the variable. A key on the command line stays in the shell history and is visible in the list of processes, so prefer the variable.

## Commands

| Command | Endpoint | Flags |
|---|---|---|
| `person` | `GET /v3/person` | exactly one of `--profile`, `--email`, `--twitter`, `--facebook`, `--github`; sections `--social-link`, `--phone-number`, `--personal-email`, `--work-email`, `--career-insight`, `--developer-profile`, `--activities`; `--max-age-seconds` |
| `company` | `GET /v3/company` | `--url` (required); sections `--funding-data`, `--exit-data`, `--acquisitions`, `--extra`, `--activities`; `--max-age-seconds` |
| `company-search` | `GET /v3/company/search` | `--q` (required) |
| `company-logo` | `GET /v3/company/logo` | `--q` (required) |
| `email-prospect` | `GET /v3/email/prospect` | `--full-name`, or `--first-name` and/or `--last-name`, together with `--domain`; `--limit` (1–10) |
| `email-validate` | `GET /v3/email/validate` | `--email` (required) |

Every flag is the API parameter in words joined by hyphens: `maxAgeSeconds` is `--max-age-seconds`, `full_name` is `--full-name`. A section flag takes no value: `--work-email` sends `workEmail=include`, and without it the API leaves the section out. `node build/cli.js <command> --help` describes every flag.

```sh
node build/cli.js person --profile williamhgates --work-email
node build/cli.js company --url https://www.linkedin.com/company/microsoft --funding-data
node build/cli.js company-search --q microsoft
node build/cli.js email-prospect --full-name "Satya Nadella" --domain microsoft.com
```

## Output

A successful call prints one JSON object to stdout:

```json
{"data": {"…": "…"}, "creditCost": 1, "requestId": "6b0c…"}
```

`data` is the full v3 answer, `creditCost` the credits charged for the call, and `requestId` the id to quote to support. In a terminal the JSON is indented; when the output goes to another program or to a file, it is one line.

An error prints one line to stderr that starts with `error:`, with the credits charged and the request id when the API answered; stdout stays empty.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the answer arrived, or `--dry-run` passed |
| 1 | unexpected error |
| 2 | wrong flags or values, including a request the API rejected as invalid (400) |
| 3 | API key or account: no key, a malformed key, a rejected key (401), access denied or not enough credits (403) |
| 4 | not found (404) |
| 5 | not now: no fresh enough copy (409), rate limit (429), the API unavailable (5xx) or not reachable |
| 6 | the answer did not arrive (timeout or a broken connection); the call may still be charged |
| 130 | stopped with Ctrl-C |

## Dry run

`--dry-run` makes every check of a real call, the API key included, and prints the request instead of sending it, so nothing is charged. The key itself is not printed: the `Authorization` header shows where it came from.

```sh
node build/cli.js person --profile williamhgates --dry-run
```

## Long calls

`person` and `company` answer from a cached copy no older than `--max-age-seconds` (30 days by default), usually within seconds. A small value starts a live lookup, which is slower, costs more and can take up to 5 minutes. In a terminal, a line on stderr shows how long the call has been waiting.

Ctrl-C stops waiting and exits with 130. The CLI stops waiting by itself after about 5 minutes and exits with 6. In both cases the call may still be charged: to get the copy that was saved in the meantime, run the same command without `--max-age-seconds` instead of repeating a live lookup.

A call is retried only when the API answers 429 or 5xx, at most twice, and never after a timeout or a broken connection.

## Environment

| Variable | Use |
|---|---|
| `ENRICHLAYER_API_KEY` | the API key, when `--api-key` is not given |
| `ENRICHLAYER_API_BASE_URL` | the API host, `https://api.enrichlayer.com` by default |

## Development

The command flags come from a copy of the published v3 spec in `spec/v3-openapi.json`.

```sh
npm run update-spec                     # refresh the copy from the published spec
npm run gen:params                      # regenerate src/generated/v3-params.ts
npm test                                # build and run the tests
node scripts/check-published-spec.mjs   # compare the copy with the published spec
```

CI runs the type check and the tests on Node.js 20, 22 and 24, and compares the copy with the published spec on every change and every night.

## License

MIT
