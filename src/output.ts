import type { V3Result } from "./client.js";

export const FORMATS = ["json", "table", "csv", "yaml", "jsonl"] as const;
export type Format = (typeof FORMATS)[number];

type Plain = string | number | boolean | null;
type Cell = Plain | { json: string };
type Row = [string, Cell][];

export interface RenderOptions {
  result: V3Result;
  format: Format;
  fields?: string[];
  rowsPath?: string;
  isTerminal: boolean;
}

export interface Rendered {
  stdout: string;
  notes: string[];
}

function isContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function flatten(value: unknown, path: string, row: Row, hidden: Map<string, number>, expandLists: boolean): void {
  if (Array.isArray(value)) {
    if (!value.some(isContainer)) {
      row.push([path, { json: JSON.stringify(value) }]);
      return;
    }
    if (!expandLists) {
      hidden.set(path, (hidden.get(path) ?? 0) + value.length);
      return;
    }
    value.forEach((item, index) => flatten(item, `${path}.${index}`, row, hidden, true));
    return;
  }
  if (isContainer(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 && path) row.push([path, { json: "{}" }]);
    for (const [key, item] of entries) flatten(item, path ? `${path}.${key}` : key, row, hidden, expandLists);
    return;
  }
  row.push([path, value as Plain]);
}

function joinPath(path: string, rest: string): string {
  return path ? `${path}.${rest}` : rest;
}

function pick(value: unknown, segments: string[], path: string, row: Row): void {
  if (segments.length === 0) {
    flatten(value, path, row, new Map(), true);
    return;
  }
  const [segment, ...rest] = segments;
  if (Array.isArray(value)) {
    if (/^\d+$/.test(segment) && Number(segment) < value.length) {
      pick(value[Number(segment)], rest, joinPath(path, segment), row);
      return;
    }
    if (!/^\d+$/.test(segment) && value.length > 0) {
      value.forEach((item, index) => pick(item, segments, joinPath(path, String(index)), row));
      return;
    }
  } else if (isContainer(value) && Object.hasOwn(value, segment)) {
    pick((value as Record<string, unknown>)[segment], rest, joinPath(path, segment), row);
    return;
  }
  row.push([joinPath(path, segments.join(".")), null]);
}

function recordsOf(data: unknown, rowsPath: string | undefined): unknown[] {
  if (Array.isArray(data)) return data;
  if (rowsPath && isContainer(data) && Array.isArray((data as Record<string, unknown>)[rowsPath])) {
    const { [rowsPath]: items, ...parent } = data as Record<string, unknown>;
    return (items as unknown[]).map((item) => (isContainer(item) && !Array.isArray(item) ? { ...parent, ...item } : { ...parent, value: item }));
  }
  return [data];
}

function rowsOf(records: unknown[], fields: string[] | undefined, hidden: Map<string, number>): Row[] {
  return records.map((record) => {
    const row: Row = [];
    if (!fields) {
      flatten(isContainer(record) && !Array.isArray(record) ? record : { value: record }, "", row, hidden, false);
      return row;
    }
    for (const field of fields) pick(record, field.split("."), "", row);
    return row;
  });
}

function columnsOf(rows: Row[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) for (const [path] of row) columns.add(path);
  return [...columns];
}

function cellText(cell: Cell | undefined): string {
  if (cell === undefined || cell === null) return "";
  if (typeof cell === "object") return cell.json;
  return String(cell);
}

function tableText(text: string): string {
  return text.replace(/[\t\n\r\v\f\x85\u2028\u2029]/g, " ").replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/g, "\uFFFD");
}

function renderTable(rows: Row[], isList: boolean): string {
  if (rows.length === 0) return "";
  if (!isList) {
    const [row] = rows;
    if (row.length === 0) return "";
    const width = Math.max(...row.map(([path]) => tableText(path).length));
    return row.map(([path, cell]) => `${tableText(path).padEnd(width)}  ${tableText(cellText(cell))}`.trimEnd()).join("\n") + "\n";
  }
  const columns = columnsOf(rows);
  const lines = [columns.map(tableText), ...rows.map((row) => {
    const cells = new Map(row);
    return columns.map((column) => tableText(cellText(cells.get(column))));
  })];
  const widths = columns.map((_, index) => Math.max(...lines.map((line) => line[index].length)));
  return lines.map((line) => line.map((text, index) => text.padEnd(widths[index])).join("  ").trimEnd()).join("\n") + "\n";
}

function csvText(text: string, isText: boolean): string {
  const cleaned = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "\uFFFD");
  const guarded = isText && /^[=+\-@\t\r]/.test(text) ? `'${cleaned}` : cleaned;
  return /[",\r\n]/.test(guarded) || guarded !== guarded.trim() ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

function renderCsv(rows: Row[]): string {
  if (rows.length === 0) return "";
  const columns = columnsOf(rows);
  const lines = [
    columns.map((column) => csvText(column, true)),
    ...rows.map((row) => {
      const cells = new Map(row);
      return columns.map((column) => {
        const cell = cells.get(column);
        return csvText(cellText(cell), typeof cell === "string");
      });
    }),
  ];
  return lines.map((line) => line.join(",")).join("\r\n") + "\r\n";
}

const UNSAFE_CHARS = /[\u007f-\u009f\u2028\u2029\ufffe\uffff]/g;
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const YAML_WORDS = /^(y|n|yes|no|on|off|true|false|null)$/i;

function escapeUnsafe(json: string): string {
  return json.replace(UNSAFE_CHARS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function yamlString(text: string): string {
  return escapeUnsafe(JSON.stringify(text));
}

function yamlKey(key: string): string {
  return PLAIN_KEY.test(key) && !YAML_WORDS.test(key) ? key : yamlString(key);
}

function isNonEmptyContainer(value: unknown): boolean {
  return isContainer(value) && Object.keys(value).length > 0;
}

function yamlInline(value: unknown): string {
  if (Array.isArray(value)) return "[]";
  if (isContainer(value)) return "{}";
  if (typeof value === "string") return yamlString(value);
  if (typeof value === "number") {
    const text = String(value);
    return text.includes("e") && !text.includes(".") ? text.replace("e", ".0e") : text;
  }
  return value === null || value === undefined ? "null" : String(value);
}

function yamlBlock(value: object, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value))
    return value.flatMap((item) => {
      if (!isNonEmptyContainer(item)) return [`${pad}- ${yamlInline(item)}`];
      const [first, ...rest] = yamlBlock(item, indent + 2);
      return [`${pad}- ${first.trimStart()}`, ...rest];
    });
  return Object.entries(value).flatMap(([key, item]) =>
    isNonEmptyContainer(item) ? [`${pad}${yamlKey(key)}:`, ...yamlBlock(item, indent + 2)] : [`${pad}${yamlKey(key)}: ${yamlInline(item)}`],
  );
}

export function toYaml(value: object): string {
  return `${yamlBlock(value, 0).join("\n")}\n`;
}

function hiddenNote(hidden: Map<string, number>): string[] {
  if (hidden.size === 0) return [];
  const lists = [...hidden].map(([path, count]) => `${path} (${count} ${count === 1 ? "item" : "items"})`);
  return [`Lists left out: ${lists.join(", ")}; name them in --fields to show them.`];
}

export function render({ result, format, fields, rowsPath, isTerminal }: RenderOptions): Rendered {
  if (format === "json") return { stdout: `${escapeUnsafe(isTerminal ? JSON.stringify(result, null, 2) : JSON.stringify(result))}\n`, notes: [] };
  if (format === "jsonl") return { stdout: `${escapeUnsafe(JSON.stringify(result))}\n`, notes: [] };
  if (format === "yaml") return { stdout: toYaml(result), notes: [] };

  const hidden = new Map<string, number>();
  const rows = rowsOf(recordsOf(result.data, rowsPath), fields, hidden);
  const isList = Array.isArray(result.data) || rowsPath !== undefined;
  const stdout = format === "table" ? renderTable(rows, isList) : renderCsv(rows);
  const cost = `credits charged: ${result.creditCost ?? "unknown"}, request id: ${result.requestId ?? "unknown"}`;
  return { stdout, notes: [...hiddenNote(hidden), cost] };
}
