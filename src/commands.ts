import type { V3Path } from "./generated/v3-params.js";

export interface CommandDef {
  path: V3Path;
  description: string;
  checkParams?: (params: Record<string, unknown>) => string | null;
}

const PERSON_IDENTIFIERS = ["profile", "email", "twitter", "facebook", "github"];

function isGiven(value: unknown): boolean {
  return typeof value === "string" ? value.trim() !== "" : value !== undefined;
}

const SECTIONS = "Section flags add data to the answer and to the cost of the call.";

const FRESHNESS =
  "--max-age-seconds is the oldest cached copy you accept (default 30 days, usually answered in seconds); a small value starts a live lookup, which is slower, costs more and can take up to 5 minutes.";

const VERDICTS = "valid, invalid, catchall, malformed or another value";

export const commandDefs: CommandDef[] = [
  {
    path: "/v3/person",
    description: [
      "Look up one person by exactly one identifier: --profile (LinkedIn profile URL or username), --email, --twitter, --facebook or --github.",
      SECTIONS,
      "--personal-email and --work-email return only addresses validated as deliverable.",
      FRESHNESS,
    ].join(" "),
    checkParams: (params) => {
      const given = PERSON_IDENTIFIERS.filter((name) => isGiven(params[name])).map((name) => `--${name}`);
      if (given.length === 1) return null;
      const flags = PERSON_IDENTIFIERS.map((name) => `--${name}`).join(", ");
      return `Pass exactly one of ${flags}${given.length > 1 ? ` — got ${given.join(", ")}` : ""}.`;
    },
  },
  {
    path: "/v3/company",
    description: ["Look up a company by its LinkedIn company or showcase page URL (--url).", SECTIONS, FRESHNESS].join(" "),
  },
  {
    path: "/v3/company/search",
    description:
      "Search companies by name (--q). Returns up to 10 matches with the company name, logo URL, domain, industry, size, location and LinkedIn URL; pass the LinkedIn URL to the company command for the full profile.",
  },
  {
    path: "/v3/company/logo",
    description: "Find companies by name or domain (--q) and get their logo URLs, with the company name, domain and LinkedIn URL.",
  },
  {
    path: "/v3/email/prospect",
    description: [
      "Find work email candidates for a person at a company: pass --full-name, or --first-name and/or --last-name, together with --domain.",
      `Each candidate has a validation verdict in validity — ${VERDICTS}; only valid is confirmed deliverable.`,
    ].join(" "),
    checkParams: (params) =>
      (isGiven(params.full_name) || isGiven(params.first_name) || isGiven(params.last_name)) && isGiven(params.domain)
        ? null
        : "Pass --full-name, or --first-name and/or --last-name, together with --domain.",
  },
  {
    path: "/v3/email/validate",
    description: `Check whether one email address is deliverable. emailStatus is the verdict — ${VERDICTS}; when the domain belongs to a known company, a company summary is attached.`,
  },
];
