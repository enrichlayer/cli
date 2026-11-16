import { Command, InvalidArgumentError, Option } from "commander";
import { type CommandDef, commandDefs } from "./commands.js";
import { VERSION } from "./config.js";
import { type V3Param, v3Params } from "./generated/v3-params.js";
import { FORMATS, type Format } from "./output.js";

export interface CommandRun {
  def: CommandDef;
  params: Record<string, string | number>;
  apiKey?: string;
  dryRun: boolean;
  format: Format;
  fields?: string[];
}

const DESCRIPTION =
  "Enrich Layer v3 API from the command line. Each command prints {data, creditCost, requestId} as JSON by default; --format picks table, csv, yaml or jsonl.";

const FIELDS_HELP =
  "Fields for table and csv, comma-separated, with dots for nested fields, for example fullName,location.city. Lists of objects are shown only when named here.";

function parseFields(value: string): string[] {
  const fields = value.split(",").map((field) => field.trim());
  if (fields.some((field) => !/^[^.]+(\.[^.]+)*$/.test(field)))
    throw new InvalidArgumentError("Expected comma-separated field paths, for example fullName,location.city.");
  return fields;
}

const EXIT_CODES_HELP =
  "Exit codes: 0 done, 1 unexpected error, 2 wrong flags or values, 3 API key or account, 4 not found, 5 not now, try again later, 6 no answer, the call may still be charged, 130 stopped with Ctrl-C.";

export function flagFor(name: string): string {
  return name
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

export function commandName(path: string): string {
  return path.replace(/^\/v3\//, "").replaceAll("/", "-");
}

export function splitAssignments(args: string[]): string[] {
  return args.flatMap((arg) => {
    const at = arg.indexOf("=");
    return arg.startsWith("--") && at > 2 ? [arg.slice(0, at), arg.slice(at + 1)] : [arg];
  });
}

function isSection(param: V3Param): boolean {
  return param.enum !== undefined && [...param.enum].sort().join() === "exclude,include" && param.default === "exclude";
}

function expectedNumber({ minimum, maximum }: V3Param): string {
  if (minimum !== undefined && maximum !== undefined) return `Expected a whole number from ${minimum} to ${maximum}.`;
  if (minimum !== undefined) return `Expected a whole number of ${minimum} or more.`;
  if (maximum !== undefined) return `Expected a whole number of ${maximum} or less.`;
  return "Expected a whole number.";
}

function integerParser(param: V3Param): (value: string) => number {
  return (value) => {
    const number = Number(value);
    const isInRange =
      /^-?\d+$/.test(value) &&
      Number.isSafeInteger(number) &&
      (param.minimum === undefined || number >= param.minimum) &&
      (param.maximum === undefined || number <= param.maximum);
    if (!isInRange) throw new InvalidArgumentError(expectedNumber(param));
    return number;
  };
}

export function optionFor(path: string, param: V3Param): Option {
  const flag = `--${flagFor(param.name)}`;
  if (isSection(param)) return new Option(flag, param.description);
  const description = param.default === undefined ? param.description : `${param.description} (API default: ${param.default})`;
  const option = new Option(`${flag} <value>`, description);
  if (param.required) option.makeOptionMandatory();
  if (param.enum) return option.choices(param.enum);
  if (param.type === "integer") return option.argParser(integerParser(param));
  if (param.type === "string") return option;
  throw new Error(`${path} ${param.name}: unsupported parameter type ${param.type}`);
}

export type AuthAction = "save" | "status" | "remove";

export interface Handlers {
  run: (run: CommandRun) => Promise<void>;
  auth: (action: AuthAction) => Promise<void>;
}

export function buildProgram({ run: onRun, auth: onAuth }: Handlers): Command {
  const program = new Command("enrichlayer-v3")
    .description(DESCRIPTION)
    .version(VERSION)
    .addHelpText("after", `\n${EXIT_CODES_HELP}`)
    .exitOverride();

  for (const def of commandDefs) {
    const command = program
      .command(commandName(def.path))
      .summary(def.description.split(/(?<=\.) /)[0])
      .description(def.description);
    const params = new Map<string, V3Param>();
    for (const param of v3Params[def.path]) {
      const option = optionFor(def.path, param);
      params.set(option.attributeName(), param);
      command.addOption(option);
    }
    command
      .addOption(new Option("--format <name>", "Output format: json (default), table, csv, yaml or jsonl.").choices(FORMATS))
      .addOption(new Option("--fields <paths>", FIELDS_HELP).argParser(parseFields))
      .option("--api-key <key>", "API key; without it, ENRICHLAYER_API_KEY or the key file is used")
      .option("--dry-run", "Print the request instead of sending it; nothing is charged")
      .action(async (options: Record<string, unknown>) => {
        const given: Record<string, string | number> = {};
        for (const [attribute, param] of params) {
          const value = options[attribute];
          if (value !== undefined) given[param.name] = value === true ? "include" : (value as string | number);
        }
        await onRun({
          def,
          params: given,
          apiKey: options.apiKey as string | undefined,
          dryRun: options.dryRun === true,
          format: (options.format as Format | undefined) ?? "json",
          fields: options.fields as string[] | undefined,
        });
      });
  }

  const auth = program.command("auth").description("Save, check or remove the API key in the key file.");
  auth.command("save").description("Save the API key from stdin to the key file.").action(() => onAuth("save"));
  auth.command("status").description("Show which API key is in use and where the key file is.").action(() => onAuth("status"));
  auth.command("remove").description("Remove the key file.").action(() => onAuth("remove"));
  return program;
}
