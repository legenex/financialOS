/**
 * Formula-injection-safe CSV export (RFC 4180 quoting, OWASP CSV-injection neutralisation).
 *
 * Any cell whose first non-space character could start a spreadsheet formula (`=`, `+`, `-`, `@`, tab, CR, or
 * their full-width forms) is prefixed with a single quote. Columns marked as numeric keep plain decimal numbers
 * such as `-1234.50` unchanged so exported amounts stay usable.
 */

export type CsvCell = string | number | bigint | boolean | null | undefined;

export interface CsvExportOptions {
  /** Column names or zero-based indexes whose pure decimal values are exported unmodified. */
  numericColumns?: ReadonlyArray<string | number>;
  delimiter?: ',' | ';';
  lineEnding?: '\r\n' | '\n';
  /** Prefix a UTF-8 byte-order mark (helps some spreadsheet apps detect the encoding). */
  bom?: boolean;
}

const TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r', '\uFF1D', '\uFF0B', '\uFF0D', '\uFF20']);
const PURE_DECIMAL = /^-?\d+(\.\d+)?$/;

export function isPureDecimal(value: string): boolean {
  return PURE_DECIMAL.test(value);
}

function cellToString(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers cannot be exported');
    if (!Number.isSafeInteger(value)) throw new TypeError('Use decimal strings for non-integer or unsafe numbers');
    return String(value);
  }
  return String(value);
}

/** Neutralises a cell that a spreadsheet could interpret as a formula. */
export function neutraliseCell(value: string, numeric = false): string {
  if (value === '') return value;
  if (numeric && PURE_DECIMAL.test(value)) return value;
  const first = value.replace(/^[ \u00A0]+/, '').charAt(0);
  if (TRIGGERS.has(first) || TRIGGERS.has(value.charAt(0))) return `'${value}`;
  return value;
}

/** Quotes a field per RFC 4180 when it contains a delimiter, quote, line break, or edge whitespace. */
export function quoteField(value: string, delimiter: ',' | ';' = ','): string {
  const needsQuotes = value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value);
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

export class CsvWriter {
  private readonly numeric: Set<number>;
  private readonly delimiter: ',' | ';';
  private readonly eol: string;
  private headerWritten = false;

  constructor(
    private readonly headers: readonly string[],
    private readonly options: CsvExportOptions = {},
  ) {
    this.delimiter = options.delimiter ?? ',';
    this.eol = options.lineEnding ?? '\r\n';
    this.numeric = new Set(
      (options.numericColumns ?? []).map((c) => {
        const idx = typeof c === 'number' ? c : headers.indexOf(c);
        if (idx < 0 || idx >= headers.length) throw new RangeError(`Unknown numeric column: ${String(c)}`);
        return idx;
      }),
    );
  }

  header(): string {
    this.headerWritten = true;
    const line = this.headers.map((h) => quoteField(neutraliseCell(h), this.delimiter)).join(this.delimiter) + this.eol;
    return this.options.bom ? `\uFEFF${line}` : line;
  }

  row(cells: readonly CsvCell[]): string {
    if (cells.length !== this.headers.length) throw new RangeError(`Expected ${this.headers.length} cells, got ${cells.length}`);
    const prefix = this.headerWritten ? '' : this.header();
    return prefix + cells.map((cell, i) => quoteField(neutraliseCell(cellToString(cell), this.numeric.has(i)), this.delimiter)).join(this.delimiter) + this.eol;
  }
}

/** Serialises a complete table. */
export function toCsv(headers: readonly string[], rows: Iterable<readonly CsvCell[]>, options: CsvExportOptions = {}): string {
  const writer = new CsvWriter(headers, options);
  let out = writer.header();
  for (const row of rows) out += writer.row(row);
  return out;
}
