import { Command, InvalidArgumentError, Option } from "commander";
import { type CommandDef, commandDefs } from "./commands.js";
import { VERSION } from "./config.js";
import { type V3Param, v3Params } from "./generated/v3-params.js";

export interface CommandRun {
  def: CommandDef;
  params: Record<string, string | number>;
  apiKey?: string;
  dryRun: boolean;
}

const DESCRIPTION = "Enrich Layer v3 API from the command line. Each command prints the answer as JSON: {data, creditCost, requestId}.";

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

export function buildProgram(onRun: (run: CommandRun) => Promise<void>): Command {
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
      .option("--api-key <key>", "API key; without it, ENRICHLAYER_API_KEY is used")
      .option("--dry-run", "Print the request instead of sending it; nothing is charged")
      .action(async (options: Record<string, unknown>) => {
        const given: Record<string, string | number> = {};
        for (const [attribute, param] of params) {
          const value = options[attribute];
          if (value !== undefined) given[param.name] = value === true ? "include" : (value as string | number);
        }
        await onRun({ def, params: given, apiKey: options.apiKey as string | undefined, dryRun: options.dryRun === true });
      });
  }
  return program;
}
