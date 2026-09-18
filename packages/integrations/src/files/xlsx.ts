import readXlsxFile from 'read-excel-file/node';
import { D, toDecimalString } from '@financialos/domain';
import { FileParseError, FileRejectedError } from '../core/errors';
import { CSV_LIMITS, detectHeader, headerFingerprint } from './csv';
import { cleanText, columnName, type Table } from './normalize';
import { inspectOoxmlZip } from './zip';

export const XLSX_PARSER_VERSION = '1.0.0';

export interface XlsxReadOptions {
  sheetName?: string | null;
  skipRows?: number;
  hasHeader?: boolean | null;
  maxRows?: number;
}

export interface ParsedXlsx extends Table {
  sheetNames: string[];
  sheetName: string;
  hasHeader: boolean;
  headerFingerprint: string | null;
  /** Column indexes whose non-empty data cells are all typed numbers (canonical "." decimals). */
  numericColumns: Set<number>;
  truncated: boolean;
}

function cellToString(value: unknown): { text: string; numeric: boolean } {
  if (value === null || value === undefined) return { text: '', numeric: false };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { text: '', numeric: false };
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return { text: `${y}-${m}-${d}`, numeric: false };
  }
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', numeric: false };
  if (typeof value === 'string') {
    // parseNumber returns the raw XML text for numeric cells; recognise it without floating point.
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return { text: toDecimalString(new D(value)), numeric: true };
    return { text: value, numeric: false };
  }
  if (typeof value === 'number') throw new FileParseError('Unexpected floating-point cell value');
  return { text: String(value), numeric: false };
}

/**
 * Reads one worksheet into string cells. The ZIP is inspected first (size, entry count, compression ratio,
 * macros, external links, DOCTYPE) and the workbook is only handed to the reader when every check passes.
 */
export async function readXlsx(bytes: Uint8Array, options: XlsxReadOptions = {}): Promise<ParsedXlsx> {
  const inspection = inspectOoxmlZip(bytes);
  if (!inspection.ok) throw new FileRejectedError('The workbook failed safety checks', inspection.checks);
  let sheets: Array<{ sheet: string; data: unknown[][] }>;
  try {
    sheets = (await readXlsxFile<string>(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      trim: false,
      parseNumber: (s: string) => s,
    })) as unknown as Array<{ sheet: string; data: unknown[][] }>;
  } catch {
    throw new FileParseError('The workbook could not be read. Re-save it as .xlsx or export as CSV.');
  }
  if (sheets.length === 0) throw new FileParseError('The workbook has no worksheets');
  const sheetNames = sheets.map((s) => s.sheet);
  const chosen = options.sheetName ? sheets.find((s) => s.sheet === options.sheetName) : sheets.find((s) => s.data.length > 0) ?? sheets[0];
  if (!chosen) throw new FileParseError(`Worksheet "${cleanText(options.sheetName ?? '', 100)}" was not found`);

  const skipRows = options.skipRows ?? 0;
  const maxRows = Math.min(options.maxRows ?? CSV_LIMITS.maxRows, CSV_LIMITS.maxRows);
  const grid = chosen.data.map((row) => row.map(cellToString));
  const width = Math.max(0, ...grid.slice(0, 1000).map((r) => r.length));
  if (width > CSV_LIMITS.maxColumns) throw new FileParseError(`The worksheet has more than ${CSV_LIMITS.maxColumns} columns`);
  const body = grid.slice(skipRows);
  const textBody = body.map((r) => r.map((c) => c.text));
  const hasHeader = options.hasHeader ?? detectHeader(textBody.slice(0, 10));
  const headerIndex = hasHeader ? textBody.findIndex((r) => r.some((c) => c.trim() !== '')) : -1;
  const headers =
    headerIndex >= 0
      ? uniqueHeaders(textBody[headerIndex]!, width)
      : Array.from({ length: width }, (_, i) => columnName(i));
  const rows: Table['rows'] = [];
  const numericSeen = new Map<number, boolean>();
  let truncated = false;
  for (let i = headerIndex + 1; i < body.length; i += 1) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const cells = body[i]!;
    cells.forEach((c, idx) => {
      if (c.text === '') return;
      numericSeen.set(idx, (numericSeen.get(idx) ?? true) && c.numeric);
    });
    rows.push({ rowNumber: skipRows + i + 1, cells: cells.map((c) => (c.text.length > CSV_LIMITS.maxFieldChars ? c.text.slice(0, CSV_LIMITS.maxFieldChars) : c.text)) });
  }
  const numericColumns = new Set([...numericSeen.entries()].filter(([, all]) => all).map(([idx]) => idx));
  return {
    sheetNames,
    sheetName: chosen.sheet,
    hasHeader: headerIndex >= 0,
    headers,
    rows,
    headerFingerprint: headerIndex >= 0 ? headerFingerprint(headers) : null,
    numericColumns,
    truncated,
  };
}

function uniqueHeaders(raw: string[], width: number): string[] {
  const seen = new Map<string, number>();
  return Array.from({ length: Math.max(width, raw.length) }, (_, i) => {
    const base = cleanText(raw[i] ?? '', 100) || columnName(i);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** Rewrites typed numeric cells into the mapping's decimal convention so one mapping serves text and typed cells. */
export function localiseTypedNumbers(table: ParsedXlsx, decimalSeparator: '.' | ','): Table {
  if (decimalSeparator === '.') return table;
  return {
    headers: table.headers,
    rows: table.rows.map((r) => ({
      rowNumber: r.rowNumber,
      cells: r.cells.map((c, i) => (table.numericColumns.has(i) ? c.replace('.', ',') : c)),
    })),
  };
}
