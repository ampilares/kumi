/**
 * Stage 2b of the Notion import: CSV → rows plus a conservatively inferred
 * schema. Pure, like {@link parseMd}: text in, records out.
 *
 * Notion's CSV export is untyped — every column is text, including what were
 * selects, dates, checkboxes and relations. The types have to be re-derived,
 * and the rule is deliberately timid: a column takes a type only when EVERY
 * non-empty value in it fits that type, and anything else stays text with a
 * warning naming the values that spoiled it. Losing a type is recoverable by
 * hand; losing a value is not.
 *
 * Inference order (first match wins, all values must agree):
 * 1. **checkbox** — every value is `Yes`/`No` (or `true`/`false`, `✅`/`❌`).
 * 2. **number** — every value parses as a finite number (thousands separators
 *    and a leading `-` allowed; units and currency symbols do not).
 * 3. **date** — every value parses as ISO (`2026-08-19`, with optional time) or
 *    Notion's long form (`August 19, 2026 10:30 AM`), optionally a `→` range.
 * 4. **url** — every value is an `http(s)://` URL.
 * 5. **multi_select** — every value is a comma-separated list of short tokens,
 *    at least one value has two or more, and the distinct tokens are few
 *    relative to the row count (options, not free text).
 * 6. **select** — every value is one short token, repeated across rows, with
 *    few distinct values.
 * 7. **text** — everything else.
 *
 * The first column is always the title property, per Notion's export.
 */

export type InferredPropertyType =
  | "title"
  | "text"
  | "number"
  | "date"
  | "checkbox"
  | "select"
  | "multi_select"
  | "url";

export interface InferredColumn {
  name: string;
  type: InferredPropertyType;
  /** Distinct option names, in first-seen order (select/multi_select). */
  options: string[];
  /** Why a column was not given a richer type; surfaced in the plan. */
  warning: string | null;
}

export interface CsvTable {
  header: string[];
  /** Data rows, padded to the header width. */
  rows: string[][];
  /** 1-based source line each row started on, for loss items. */
  rowLines: number[];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * RFC 4180 reader: quoted fields may contain commas, newlines and doubled
 * quotes. A stray quote inside an unquoted field is kept verbatim rather than
 * treated as an error — the goal is to lose nothing.
 */
export function parseCsv(text: string): CsvTable {
  const source = text.replace(/^﻿/, "");
  const records: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let started = false;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    records.push(row);
    lines.push(rowLine);
    row = [];
    started = false;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? "";
    if (!started && !quoted) {
      rowLine = line;
      started = true;
    }
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        quoted = false;
        continue;
      }
      if (ch === "\n") line += 1;
      field += ch;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      endField();
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      endRow();
      line += 1;
      continue;
    }
    field += ch;
  }
  if (field !== "" || row.length > 0 || quoted) endRow();

  const header = records.shift() ?? [];
  lines.shift();
  const width = header.length;
  const rows = records
    // A trailing newline produces one empty record; it is not a row.
    .filter((record) => record.some((cell) => cell.trim() !== ""))
    .map((record) => {
      const padded = record.slice(0, width);
      while (padded.length < width) padded.push("");
      return padded;
    });
  const rowLines = lines.slice(0, rows.length);
  return { header: header.map((name) => name.trim()), rows, rowLines };
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

const TRUE_VALUES = new Set(["yes", "true", "✅", "checked"]);
const FALSE_VALUES = new Set(["no", "false", "❌", "unchecked"]);

/** `Yes`/`No` and friends → boolean; null when the value is not a checkbox. */
export function parseCheckbox(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return null;
}

const NUMBER_PATTERN = /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;

/** A bare number, with optional thousands separators. */
export function parseNumber(raw: string): number | null {
  const value = raw.trim();
  if (value === "" || !NUMBER_PATTERN.test(value)) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

const MONTHS: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
const LONG_DATE = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?)?$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** One date endpoint → an ISO string Kumi accepts, or null. */
export function parseDatePoint(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;

  const iso = ISO_DATE.exec(value);
  if (iso !== null) {
    const [, year = "", month = "", day = "", hour, minute, second, zone] = iso;
    const monthNumber = Number(month);
    const dayNumber = Number(day);
    if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return null;
    if (hour === undefined) return `${year}-${month}-${day}`;
    const time = `${hour}:${minute}:${second ?? "00"}`;
    return `${year}-${month}-${day}T${time}${zone ?? ""}`;
  }

  const long = LONG_DATE.exec(value);
  if (long !== null) {
    const month = MONTHS[(long[1] ?? "").toLowerCase()];
    if (month === undefined) return null;
    const day = Number(long[2] ?? "0");
    const year = Number(long[3] ?? "0");
    if (day < 1 || day > 31) return null;
    const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
    if (long[4] === undefined) return date;
    let hour = Number(long[4]);
    const meridiem = (long[6] ?? "").toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour > 23) return null;
    return `${date}T${pad(hour)}:${long[5] ?? "00"}:00`;
  }

  return null;
}

export interface ParsedDate {
  start: string;
  end: string | null;
}

/** A Notion date cell, including `A → B` ranges. */
export function parseDateValue(raw: string): ParsedDate | null {
  const value = raw.trim();
  if (value === "") return null;
  const parts = value.split(/\s*(?:→|->|—>)\s*/);
  if (parts.length > 2) return null;
  const start = parseDatePoint(parts[0] ?? "");
  if (start === null) return null;
  if (parts.length === 1) return { start, end: null };
  const end = parseDatePoint(parts[1] ?? "");
  return end === null ? null : { start, end };
}

const URL_PATTERN = /^https?:\/\/\S+$/i;

export function isUrlValue(raw: string): boolean {
  return URL_PATTERN.test(raw.trim());
}

/** Notion joins multi-select options with `, `. */
export function splitTokens(raw: string): string[] {
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/** Longest an option name may be before the column reads as free text. */
const MAX_OPTION_LENGTH = 40;

/** Most distinct options a column may hold before it reads as free text. */
const MAX_OPTIONS = 100;

function nearMiss(values: string[], test: (value: string) => boolean): number {
  return values.filter((value) => !test(value)).length;
}

function describeFailures(values: string[], test: (value: string) => boolean): string {
  const bad = values.filter((value) => !test(value)).slice(0, 3);
  return bad.map((value) => JSON.stringify(value)).join(", ");
}

/**
 * Infer one column's type from every value in it. `rowCount` is the total
 * number of rows (including empty cells), which decides whether a column's
 * distinct values look like options or like prose.
 */
export function inferColumn(name: string, values: string[], rowCount: number): InferredColumn {
  const filled = values.map((value) => value.trim()).filter((value) => value !== "");
  const base = { name, options: [] as string[], warning: null as string | null };
  if (filled.length === 0) return { ...base, type: "text" };

  if (filled.every((value) => parseCheckbox(value) !== null)) {
    return { ...base, type: "checkbox" };
  }

  const numeric = nearMiss(filled, (value) => parseNumber(value) !== null);
  if (numeric === 0) return { ...base, type: "number" };

  const dated = nearMiss(filled, (value) => parseDateValue(value) !== null);
  if (dated === 0) return { ...base, type: "date" };

  const urls = nearMiss(filled, isUrlValue);
  if (urls === 0) return { ...base, type: "url" };

  // Options: short tokens, repeated, few distinct relative to the rows.
  const tokenLists = filled.map(splitTokens);
  const distinct: string[] = [];
  const seen = new Set<string>();
  let allShort = true;
  let anyMultiple = false;
  for (const tokens of tokenLists) {
    if (tokens.length > 1) anyMultiple = true;
    for (const token of tokens) {
      if (token.length > MAX_OPTION_LENGTH) allShort = false;
      if (!seen.has(token)) {
        seen.add(token);
        distinct.push(token);
      }
    }
  }
  const fewEnough =
    allShort &&
    distinct.length <= MAX_OPTIONS &&
    distinct.length <= Math.max(1, Math.ceil(rowCount / 2));

  if (fewEnough && anyMultiple) {
    return { ...base, type: "multi_select", options: distinct };
  }
  if (fewEnough && !anyMultiple && distinct.length < filled.length) {
    return { ...base, type: "select", options: distinct };
  }

  // Text, with an honest note when the column ALMOST had a type.
  const closest = Math.min(numeric, dated, urls);
  let warning: string | null = null;
  if (closest > 0 && closest <= Math.max(1, Math.floor(filled.length / 2))) {
    const [kind, test] =
      closest === numeric
        ? (["number", (v: string) => parseNumber(v) !== null] as const)
        : closest === dated
          ? (["date", (v: string) => parseDateValue(v) !== null] as const)
          : (["url", isUrlValue] as const);
    warning =
      `column "${name}" kept as text: ${closest} of ${filled.length} values are not ` +
      `${kind}s (${describeFailures(filled, test)})`;
  } else if (allShort && distinct.length > Math.max(1, Math.ceil(rowCount / 2))) {
    warning =
      `column "${name}" kept as text: ${distinct.length} distinct short values across ` +
      `${rowCount} rows look like free text rather than options`;
  }
  return { ...base, type: "text", warning };
}

/**
 * Infer the whole schema of a CSV. The first column is the title property; the
 * rest are inferred independently.
 */
export function inferSchema(table: CsvTable): InferredColumn[] {
  return table.header.map((name, index) => {
    if (index === 0) {
      return { name: name === "" ? "Name" : name, type: "title", options: [], warning: null };
    }
    const values = table.rows.map((row) => row[index] ?? "");
    return inferColumn(name === "" ? `Column ${index + 1}` : name, values, table.rows.length);
  });
}
