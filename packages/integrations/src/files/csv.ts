import { createHash } from 'node:crypto';
import Papa from 'papaparse';
import { ImportLimits, type ColumnMapping, type DateFormat } from '@financialos/contracts';
import { FileParseError } from '../core/errors';
import { cleanText, columnName, parseAmountValue, parseDateValue, type Table } from './normalize';

export const CSV_PARSER_VERSION = '1.0.0';

export type Delimiter = ',' | ';' | '\t' | '|';
const DELIMITERS: Delimiter[] = [',', ';', '\t', '|'];

export const CSV_LIMITS = {
  maxRows: ImportLimits.maxRows,
  maxFieldChars: 32_768,
  maxColumns: 200,
};

export interface CsvParseOptions {
  delimiter?: Delimiter | null;
  skipRows?: number;
  /** null = detect */
  hasHeader?: boolean | null;
  maxRows?: number;
}

export interface ParsedCsv extends Table {
  delimiter: Delimiter;
  hasHeader: boolean;
  /** sha256 of the normalised header names, or null when the file has no header row. */
  headerFingerprint: string | null;
  /** Rows that failed structural checks (field too long, too many columns). */
  structuralErrors: Array<{ rowNumber: number; message: string }>;
  truncated: boolean;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Normalises header text for fingerprinting: lower case, trimmed, inner whitespace collapsed. */
export function normaliseHeader(name: string): string {
  return cleanText(name, 200).toLowerCase();
}

export function headerFingerprint(headers: readonly string[]): string {
  return createHash('sha256').update(headers.map(normaliseHeader).join('\n'), 'utf8').digest('hex');
}

function parseRaw(text: string, delimiter: Delimiter, preview?: number): string[][] {
  const result = Papa.parse<string[]>(text, {
    delimiter,
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
    worker: false,
    preview: preview ?? 0,
    quoteChar: '"',
    escapeChar: '"',
  });
  return result.data;
}

/** Picks the delimiter that yields the most consistent multi-column layout in the first lines. */
export function detectDelimiter(text: string, skipRows = 0): Delimiter {
  const body = stripBom(text);
  let best: { d: Delimiter; score: number } = { d: ',', score: -1 };
  for (const d of DELIMITERS) {
    const rows = parseRaw(body, d, skipRows + 30)
      .slice(skipRows)
      .filter((r) => r.some((c) => c.trim() !== ''));
    if (rows.length === 0) continue;
    const counts = rows.map((r) => r.length);
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [mode, modeCount] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
    if (mode < 2) continue;
    const score = (modeCount / rows.length) * 100 + Math.min(mode, 20);
    if (score > best.score) best = { d, score };
  }
  return best.d;
}

const COMMON_DATE_FORMATS: DateFormat[] = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'YYYY/MM/DD', 'D MMM YYYY', 'MMM D, YYYY', 'YYYYMMDD', 'iso_datetime'];

function looksLikeValue(cell: string): boolean {
  const c = cell.trim();
  if (!c) return false;
  if (COMMON_DATE_FORMATS.some((f) => tryDate(c, f))) return true;
  return /^[-+(]?[$€£R]?\s?\d[\d\s.,']*\)?(\s?(CR|DR))?$/i.test(c);
}

function tryDate(value: string, format: DateFormat): boolean {
  try {
    parseDateValue(value, format, 'UTC');
    return true;
  } catch {
    return false;
  }
}

/** A first row is a header when it holds only labels and a later row holds dates or numbers. */
export function detectHeader(rows: string[][]): boolean {
  const first = rows.find((r) => r.some((c) => c.trim() !== ''));
  if (!first) return false;
  const labels = first.filter((c) => c.trim() !== '');
  if (labels.length === 0 || labels.some(looksLikeValue)) return false;
  const later = rows.slice(rows.indexOf(first) + 1, rows.indexOf(first) + 6);
  return later.some((r) => r.some(looksLikeValue)) || later.length === 0;
}

function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = cleanText(h, 100) || columnName(i);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/**
 * Parses CSV text into a table. Row numbers are 1-based record numbers in the file, counting skipped and
 * header rows, so errors can be traced back to the source.
 */
export function parseCsvText(input: string, options: CsvParseOptions = {}): ParsedCsv {
  const text = stripBom(input);
  const skipRows = options.skipRows ?? 0;
  const delimiter = options.delimiter ?? detectDelimiter(text, skipRows);
  const maxRows = Math.min(options.maxRows ?? CSV_LIMITS.maxRows, CSV_LIMITS.maxRows);
  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
    worker: false,
    preview: skipRows + maxRows + 2,
    quoteChar: '"',
    escapeChar: '"',
  });
  const records = parsed.data;
  const hardErrors = parsed.errors.filter((e) => e.code === 'MissingQuotes' || e.code === 'InvalidQuotes');
  const structuralErrors: ParsedCsv['structuralErrors'] = hardErrors.map((e) => ({
    rowNumber: (e.row ?? 0) + 1,
    message: e.code === 'MissingQuotes' ? 'Unterminated quoted field' : 'Invalid quoting',
  }));
  const body = records.slice(skipRows);
  const hasHeader = options.hasHeader ?? detectHeader(body.slice(0, 10));
  let headerIndex = -1;
  if (hasHeader) headerIndex = body.findIndex((r) => r.some((c) => c.trim() !== ''));
  const width = Math.max(0, ...body.slice(0, 1000).map((r) => r.length));
  if (width > CSV_LIMITS.maxColumns) throw new FileParseError(`The file has more than ${CSV_LIMITS.maxColumns} columns`);
  const headers = headerIndex >= 0 ? uniqueHeaders(body[headerIndex]!) : Array.from({ length: width }, (_, i) => columnName(i));
  const rows: Table['rows'] = [];
  const dataStart = headerIndex >= 0 ? headerIndex + 1 : 0;
  let truncated = false;
  for (let i = dataStart; i < body.length; i += 1) {
    const rowNumber = skipRows + i + 1;
    const cells = body[i]!;
    // Papa yields one trailing empty record for a final newline.
    if (i === body.length - 1 && cells.length === 1 && cells[0] === '') continue;
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    if (cells.length > CSV_LIMITS.maxColumns) {
      structuralErrors.push({ rowNumber, message: `Row has more than ${CSV_LIMITS.maxColumns} columns` });
      continue;
    }
    if (cells.some((c) => c.length > CSV_LIMITS.maxFieldChars)) {
      structuralErrors.push({ rowNumber, message: `A field exceeds ${CSV_LIMITS.maxFieldChars} characters` });
      continue;
    }
    rows.push({ rowNumber, cells });
  }
  return {
    delimiter,
    hasHeader: headerIndex >= 0,
    headers,
    rows,
    headerFingerprint: headerIndex >= 0 ? headerFingerprint(headers) : null,
    structuralErrors,
    truncated,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Mapping suggestions
// ---------------------------------------------------------------------------------------------------------

type Role = 'date' | 'valueDate' | 'description' | 'counterparty' | 'reference' | 'amount' | 'debit' | 'credit' | 'balance' | 'currency' | 'status' | 'category' | 'direction';

const SYNONYMS: Record<Role, string[]> = {
  date: ['date', 'transaction date', 'trans date', 'txn date', 'posting date', 'posted date', 'post date', 'booking date', 'booked date', 'date posted', 'completed date', 'effective date', 'entry date', 'processed date', 'started date', 'created', 'date created', 'created at'],
  valueDate: ['value date', 'settlement date', 'settled date', 'posted at'],
  description: ['description', 'transaction description', 'details', 'transaction details', 'narrative', 'narration', 'particulars', 'memo', 'remarks', 'text', 'bank description'],
  counterparty: ['counterparty', 'counterparty name', 'payee', 'merchant', 'merchant name', 'beneficiary', 'recipient', 'name', 'to from', 'payee name'],
  reference: ['reference', 'ref', 'reference number', 'transaction reference', 'transaction id', 'check number', 'cheque number', 'id'],
  amount: ['amount', 'transaction amount', 'amt', 'net amount', 'value', 'amount local'],
  debit: ['debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'money out', 'paid out', 'outflow', 'spent'],
  credit: ['credit', 'credits', 'credit amount', 'deposit', 'deposits', 'money in', 'paid in', 'inflow', 'received'],
  balance: ['balance', 'running balance', 'account balance', 'balance after', 'closing balance', 'ledger balance'],
  currency: ['currency', 'ccy', 'currency code', 'curr'],
  status: ['status', 'state', 'transaction status'],
  category: ['category', 'transaction category', 'spending category'],
  direction: ['dr cr', 'debit credit', 'cr dr', 'direction', 'dc', 'd c', 'transaction type', 'type'],
};

function headerKey(h: string): string {
  return normaliseHeader(h)
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface MappingSuggestion {
  mapping: ColumnMapping;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

export interface SuggestOptions {
  defaultCurrency: string;
  timezone: string;
  /** Used only when every sample date is ambiguous (day and month both <= 12). */
  preferDayFirst?: boolean;
  delimiter?: Delimiter | null;
  hasHeader?: boolean;
  skipRows?: number;
}

/** Chooses a date format that parses every non-empty sample, preferring unambiguous evidence. */
export function detectDateFormat(samples: string[], preferDayFirst = true): { format: DateFormat | null; ambiguous: boolean } {
  const values = samples.map((s) => s.trim()).filter(Boolean);
  if (values.length === 0) return { format: null, ambiguous: false };
  if (values.every((v) => /^\d{5}(\.\d+)?$/.test(v))) return { format: 'excel_serial', ambiguous: false };
  const candidates = COMMON_DATE_FORMATS.filter((f) => values.every((v) => tryDate(v, f)));
  if (candidates.length === 0) return { format: null, ambiguous: false };
  const hasOffset = values.some((v) => /T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/i.test(v));
  if (hasOffset && candidates.includes('iso_datetime')) return { format: 'iso_datetime', ambiguous: false };
  const dayFirst = candidates.filter((f) => f === 'DD/MM/YYYY' || f === 'DD-MM-YYYY' || f === 'DD.MM.YYYY');
  const monthFirst = candidates.filter((f) => f === 'MM/DD/YYYY');
  if (dayFirst.length && monthFirst.length) {
    return { format: preferDayFirst ? dayFirst[0]! : monthFirst[0]!, ambiguous: true };
  }
  return { format: candidates[0]!, ambiguous: false };
}

export function detectNumberFormat(samples: string[]): { decimalSeparator: '.' | ','; thousandsSeparator: ColumnMapping['thousandsSeparator'] } {
  const values = samples.map((s) => s.trim()).filter(Boolean);
  let commaDecimal = 0;
  let dotDecimal = 0;
  let space = false;
  let apostrophe = false;
  for (const v of values) {
    if (/,\d{1,2}(\s?(CR|DR))?\)?-?$/i.test(v) && !/\.\d{1,2}(\s?(CR|DR))?\)?-?$/i.test(v)) commaDecimal += 1;
    if (/\.\d{1,2}(\s?(CR|DR))?\)?-?$/i.test(v)) dotDecimal += 1;
    if (/\d[\s\u00A0]\d{3}/.test(v)) space = true;
    if (/\d'\d{3}/.test(v)) apostrophe = true;
  }
  if (commaDecimal > dotDecimal) {
    const dotGroups = values.some((v) => /\d\.\d{3}/.test(v));
    return { decimalSeparator: ',', thousandsSeparator: dotGroups ? '.' : space ? ' ' : '' };
  }
  const commaGroups = values.some((v) => /\d,\d{3}/.test(v));
  return { decimalSeparator: '.', thousandsSeparator: commaGroups ? ',' : apostrophe ? "'" : space ? ' ' : '' };
}

/** Heuristic column mapping for common English bank export headers. Always requires owner confirmation. */
export function suggestMapping(headers: string[], sampleRows: string[][], options: SuggestOptions): MappingSuggestion {
  const notes: string[] = [];
  const keys = headers.map(headerKey);
  const used = new Set<number>();
  const find = (role: Role, exactOnly = false): string | null => {
    for (const synonym of SYNONYMS[role]) {
      const idx = keys.findIndex((k, i) => !used.has(i) && k === synonym);
      if (idx >= 0) {
        used.add(idx);
        return headers[idx]!;
      }
    }
    if (exactOnly) return null;
    for (const synonym of SYNONYMS[role]) {
      if (synonym.length < 4) continue;
      const idx = keys.findIndex((k, i) => !used.has(i) && k.includes(synonym));
      if (idx >= 0) {
        used.add(idx);
        return headers[idx]!;
      }
    }
    return null;
  };
  const column = (name: string | null) => (name === null ? [] : sampleRows.map((r) => r[headers.indexOf(name)] ?? ''));

  // Order matters: specific roles before generic ones.
  let direction: string | null = null;
  const directionCandidate = find('direction', true);
  if (directionCandidate) {
    const values = column(directionCandidate).map((v) => v.trim().toLowerCase()).filter(Boolean);
    if (values.length && values.every((v) => ['dr', 'cr', 'd', 'c', 'debit', 'credit', 'db'].includes(v))) direction = directionCandidate;
    else used.delete(headers.indexOf(directionCandidate));
  }
  const valueDate = find('valueDate');
  const date = find('date');
  const debit = find('debit');
  const credit = find('credit');
  const balance = find('balance');
  const amount = find('amount');
  const currency = find('currency');
  const status = find('status');
  const category = find('category');
  const description = find('description');
  const counterparty = find('counterparty');
  const reference = find('reference');

  let dateColumn = date;
  if (!dateColumn) {
    const idx = headers.findIndex((_, i) => !used.has(i) && detectDateFormat(sampleRows.map((r) => r[i] ?? '')).format !== null);
    if (idx >= 0) {
      dateColumn = headers[idx]!;
      used.add(idx);
      notes.push(`Date column guessed from values: ${dateColumn}`);
    }
  }
  const dateDetect = detectDateFormat(column(dateColumn), options.preferDayFirst ?? true);
  if (dateDetect.ambiguous) notes.push('Dates are ambiguous (day and month both 12 or less). Confirm the date format.');
  if (!dateDetect.format) notes.push('Could not detect the date format from the samples.');

  let amountMode: ColumnMapping['amountMode'] = 'signed';
  if (!amount && debit && credit) amountMode = 'debit_credit';
  else if (amount && direction) amountMode = 'amount_direction';
  else if (!amount && (debit || credit)) notes.push('Only one of debit/credit columns was found. Check the amount columns.');
  const amountSamples = [...column(amount), ...column(debit), ...column(credit), ...column(balance)];
  const numberFormat = detectNumberFormat(amountSamples);

  const mapping: ColumnMapping = {
    hasHeader: options.hasHeader ?? true,
    skipRows: options.skipRows ?? 0,
    delimiter: options.delimiter ?? null,
    sheetName: null,
    dateColumn: dateColumn ?? headers[0] ?? 'Column 1',
    valueDateColumn: valueDate,
    dateFormat: dateDetect.format ?? 'YYYY-MM-DD',
    descriptionColumns: [description ?? counterparty ?? reference ?? headers.find((_, i) => !used.has(i)) ?? headers[0] ?? 'Column 2'],
    counterpartyColumn: description ? counterparty : null,
    referenceColumn: reference,
    balanceColumn: balance,
    currencyColumn: currency,
    statusColumn: status,
    categoryColumn: category,
    amountMode,
    amountColumn: amountMode === 'debit_credit' ? null : amount,
    debitColumn: amountMode === 'debit_credit' ? debit : null,
    creditColumn: amountMode === 'debit_credit' ? credit : null,
    directionColumn: amountMode === 'amount_direction' ? direction : null,
    debitMarkers: amountMode === 'amount_direction' ? ['DR', 'D', 'Debit', 'DB'] : [],
    negativeIsDebit: true,
    decimalSeparator: numberFormat.decimalSeparator,
    thousandsSeparator: numberFormat.thousandsSeparator,
    defaultCurrency: options.defaultCurrency,
    sourceTimezone: options.timezone,
  };
  if (amountMode === 'signed' && !amount) notes.push('No amount column was found.');
  if (amountMode === 'signed' && amount) {
    const parsed = column(amount)
      .map((v) => {
        try {
          return parseAmountValue(v, numberFormat);
        } catch {
          return null;
        }
      })
      .filter((p) => p !== null);
    if (parsed.length && parsed.every((p) => !p.value.startsWith('-') && p.marker === null)) {
      notes.push('Every sample amount is positive. Check whether this export shows spending as positive numbers.');
    }
  }
  const missingCore = !dateColumn || !dateDetect.format || (amountMode === 'signed' && !amount) || !description;
  const confidence: MappingSuggestion['confidence'] = missingCore ? 'low' : dateDetect.ambiguous || notes.length > 0 ? 'medium' : 'high';
  return { mapping, confidence, notes };
}
