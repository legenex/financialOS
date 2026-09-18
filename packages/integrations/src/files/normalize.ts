import type { ColumnMapping, DateFormat } from '@financialos/contracts';
import { D, isValidTimeZone, makeDate, toDecimalString, toLocalDate } from '@financialos/domain';

/** One source row after column mapping. Amounts are signed decimal strings: positive = money in. */
export interface NormalizedRow {
  /** 1-based row number in the source (line number for CSV, sheet row for XLSX, entry index otherwise). */
  rowNumber: number;
  bookedOn: string;
  valueOn: string | null;
  description: string;
  counterparty: string | null;
  reference: string | null;
  amount: string;
  currency: string;
  balance: string | null;
  pending: boolean;
  externalId: string | null;
  categoryHint: string | null;
  /** Verbatim cells keyed by column name. Data only. */
  raw: Record<string, string>;
}

export interface RowError {
  rowNumber: number;
  field: string | null;
  message: string;
}

export interface SkippedRow {
  rowNumber: number;
  reason: string;
}

export class ValueParseError extends Error {
  override name = 'ValueParseError';
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

// An optional trailing wall-clock time ("2026-01-31 14:05" / "31/01/2026 14:05:09") is ignored for date formats.
const TIME_SUFFIX = String.raw`(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:\s?[AaPp][Mm])?)?`;

const PATTERNS: Partial<Record<DateFormat, { re: RegExp; order: 'ymd' | 'dmy' | 'mdy' }>> = {
  'YYYY-MM-DD': { re: new RegExp(String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})${TIME_SUFFIX}$`), order: 'ymd' },
  'YYYY/MM/DD': { re: new RegExp(String.raw`^(\d{4})/(\d{1,2})/(\d{1,2})${TIME_SUFFIX}$`), order: 'ymd' },
  'DD/MM/YYYY': { re: new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})${TIME_SUFFIX}$`), order: 'dmy' },
  'MM/DD/YYYY': { re: new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})${TIME_SUFFIX}$`), order: 'mdy' },
  'DD-MM-YYYY': { re: new RegExp(String.raw`^(\d{1,2})-(\d{1,2})-(\d{4})${TIME_SUFFIX}$`), order: 'dmy' },
  'DD.MM.YYYY': { re: new RegExp(String.raw`^(\d{1,2})\.(\d{1,2})\.(\d{4})${TIME_SUFFIX}$`), order: 'dmy' },
  YYYYMMDD: { re: /^(\d{4})(\d{2})(\d{2})$/, order: 'ymd' },
};

function safeMakeDate(y: number, m: number, d: number, original: string): string {
  if (y < 1900 || y > 2200) throw new ValueParseError(`Year out of range in date "${truncate(original)}"`);
  try {
    return makeDate(y, m, d);
  } catch {
    throw new ValueParseError(`Invalid calendar date "${truncate(original)}"`);
  }
}

function truncate(value: string, max = 40): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Converts an Excel serial date (1900 date system) to an ISO date.
 * Serial 1 is 1900-01-01. Excel wrongly treats 1900 as a leap year, so serial 60 (the fictitious 1900-02-29)
 * is rejected and serials from 61 onward are shifted back by one day.
 */
export function excelSerialToDate(serial: string | number, date1904 = false): string {
  const text = String(serial).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new ValueParseError(`Invalid Excel serial date "${truncate(text)}"`);
  const whole = Number(text.split('.')[0]);
  if (!Number.isSafeInteger(whole)) throw new ValueParseError('Excel serial date out of range');
  let epochDays: number;
  if (date1904) {
    epochDays = Date.UTC(1904, 0, 1) / 86_400_000 + whole;
  } else {
    if (whole < 1) throw new ValueParseError('Excel serial date before 1900-01-01');
    if (whole === 60) throw new ValueParseError('Excel serial 60 is the non-existent date 1900-02-29');
    const base = Date.UTC(1899, 11, 31) / 86_400_000;
    epochDays = base + (whole > 60 ? whole - 1 : whole);
  }
  const dt = new Date(epochDays * 86_400_000);
  return safeMakeDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), text);
}

const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** Parses a date cell according to the mapping's format. ISO datetimes with an offset become local dates in `timezone`. */
export function parseDateValue(value: string, format: DateFormat, timezone: string): string {
  const text = value.trim();
  if (!text) throw new ValueParseError('Date is empty');
  if (format === 'excel_serial') {
    // Spreadsheet exports sometimes already contain ISO dates in a serial-typed column.
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return parseDateValue(text, 'YYYY-MM-DD', timezone);
    return excelSerialToDate(text);
  }
  if (format === 'iso_datetime') {
    const m = ISO_DATETIME.exec(text);
    if (!m) throw new ValueParseError(`Date "${truncate(text)}" is not an ISO 8601 date-time`);
    const [, y, mo, d, hh, mm, , offset] = m;
    if (!offset || hh === undefined) return safeMakeDate(Number(y), Number(mo), Number(d), text);
    if (!isValidTimeZone(timezone)) throw new ValueParseError(`Unknown time zone ${truncate(timezone)}`);
    const normalizedOffset = offset.toUpperCase() === 'Z' ? 'Z' : offset.includes(':') ? offset : `${offset.slice(0, 3)}:${offset.slice(3)}`;
    safeMakeDate(Number(y), Number(mo), Number(d), text);
    const iso = `${y}-${mo}-${d}T${hh}:${mm}:${m[6] ?? '00'}${normalizedOffset}`;
    const instant = new Date(iso);
    if (Number.isNaN(instant.getTime()) || Number(hh) > 23 || Number(mm) > 59) throw new ValueParseError(`Invalid date-time "${truncate(text)}"`);
    return toLocalDate(instant, timezone);
  }
  // A plain ISO date is unambiguous in any column (typed spreadsheet dates are delivered this way).
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso && format !== 'YYYYMMDD') return safeMakeDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), text);
  if (format === 'D MMM YYYY') {
    const m = new RegExp(String.raw`^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ ,-]*(\d{4})${TIME_SUFFIX}$`).exec(text);
    const month = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
    if (!m || !month) throw new ValueParseError(`Date "${truncate(text)}" does not match D MMM YYYY`);
    return safeMakeDate(Number(m[3]), month, Number(m[1]), text);
  }
  if (format === 'MMM D, YYYY') {
    const m = new RegExp(String.raw`^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})${TIME_SUFFIX}$`).exec(text);
    const month = m ? MONTHS[m[1]!.toLowerCase()] : undefined;
    if (!m || !month) throw new ValueParseError(`Date "${truncate(text)}" does not match MMM D, YYYY`);
    return safeMakeDate(Number(m[3]), month, Number(m[2]), text);
  }
  const spec = PATTERNS[format];
  if (!spec) throw new ValueParseError(`Unsupported date format ${format}`);
  const m = spec.re.exec(text);
  if (!m) throw new ValueParseError(`Date "${truncate(text)}" does not match ${format}`);
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (spec.order === 'ymd') return safeMakeDate(a, b, c, text);
  if (spec.order === 'dmy') return safeMakeDate(c, b, a, text);
  return safeMakeDate(c, a, b, text);
}

export interface NumberFormat {
  decimalSeparator: '.' | ',';
  thousandsSeparator: ',' | '.' | ' ' | "'" | '';
}

export interface ParsedAmount {
  /** Signed decimal as written (parentheses and trailing minus applied). */
  value: string;
  /** CR/DR marker found next to the number, if any. */
  marker: 'CR' | 'DR' | null;
}

const CURRENCY_SYMBOLS = /[$€£¥₹₩₪₦₱฿₫₴₽¢]/g;
const SPACES = /[\s\u00A0\u2007\u202F]/g;

/**
 * Parses a human-formatted amount. Handles thousands/decimal separators, parentheses negatives, leading or
 * trailing minus, currency symbols or ISO codes, and CR/DR markers. Returns null for an empty cell.
 */
export function parseAmountValue(input: string, fmt: NumberFormat): ParsedAmount | null {
  let text = input.trim();
  if (text === '' || text === '-' || text === '—') return null;
  let negative = false;
  let marker: 'CR' | 'DR' | null = null;
  const suffix = /^(.*[\d)])\s*(cr|dr)\.?$/i.exec(text);
  const prefix = suffix ? null : /^(cr|dr)\.?\s+(.*)$/i.exec(text);
  if (suffix) {
    marker = suffix[2]!.toUpperCase() as 'CR' | 'DR';
    text = suffix[1]!.trim();
  } else if (prefix) {
    marker = prefix[1]!.toUpperCase() as 'CR' | 'DR';
    text = prefix[2]!.trim();
  }
  text = text.replace(/\u2212/g, '-');
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  // Currency codes or symbols before/after the number (e.g. "USD 1,234.50", "R 1 234,50", "1.234,50 €").
  text = text.replace(/^[A-Z]{3}\s*/, '').replace(/\s*[A-Z]{3}$/, '');
  text = text.replace(/^R(?=[\s\d-])/, '');
  text = text.replace(CURRENCY_SYMBOLS, '').trim();
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1).trim();
  } else if (text.startsWith('+')) {
    text = text.slice(1).trim();
  }
  if (text.endsWith('-')) {
    negative = !negative;
    text = text.slice(0, -1).trim();
  }
  if (/^\(.*\)$/.test(text)) {
    negative = !negative;
    text = text.slice(1, -1).trim();
  }
  // Currency symbols can also sit between the sign and the digits ("-$12.00").
  text = text.replace(CURRENCY_SYMBOLS, '').replace(SPACES, fmt.thousandsSeparator === ' ' ? '' : ' ').trim();
  if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(text)) {
    const value = new D(text);
    return { value: toDecimalString(negative ? value.negated() : value), marker };
  }
  const { decimalSeparator: dsep, thousandsSeparator: tsep } = fmt;
  if (tsep !== '' && tsep !== ' ') {
    const groups = text.split(dsep);
    if (groups.length > 2) throw new ValueParseError(`Amount "${truncate(input)}" has more than one decimal separator`);
    const intPart = groups[0]!;
    const escaped = tsep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (intPart.includes(tsep) && !new RegExp(`^\\d{1,3}(?:${escaped}\\d{3})+$`).test(intPart)) {
      throw new ValueParseError(`Amount "${truncate(input)}" has misplaced thousands separators`);
    }
    text = [intPart.split(tsep).join(''), ...groups.slice(1)].join(dsep);
  }
  if (/\s/.test(text)) throw new ValueParseError(`Amount "${truncate(input)}" contains unexpected spaces`);
  if (dsep === ',') {
    if (text.includes('.')) throw new ValueParseError(`Amount "${truncate(input)}" uses "." but the decimal separator is ","`);
    text = text.replace(',', '.');
  } else if (text.includes(',')) {
    throw new ValueParseError(`Amount "${truncate(input)}" uses "," but the decimal separator is "."`);
  }
  if (/^\.\d+$/.test(text)) text = `0${text}`;
  if (!/^\d+(\.\d+)?$/.test(text)) throw new ValueParseError(`Amount "${truncate(input)}" is not a number`);
  const value = new D(text);
  return { value: toDecimalString(negative ? value.negated() : value), marker };
}

const PENDING_STATUS = /\b(pending|authori[sz](ed|ation)|reserved|on hold|hold|processing|uncleared|not cleared|in progress)\b/i;

export function isPendingStatus(value: string | null | undefined): boolean {
  return !!value && PENDING_STATUS.test(value);
}

/** Collapses whitespace, strips control characters, and bounds the length of free text taken from files. */
export function cleanText(value: string | null | undefined, max = 500): string {
  if (!value) return '';
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}

export interface Table {
  headers: string[];
  rows: Array<{ rowNumber: number; cells: string[] }>;
}

export interface MapOptions {
  /** Overrides mapping.sourceTimezone when set. */
  timezone?: string;
  /** Overrides mapping.defaultCurrency when set. */
  currency?: string;
}

export interface MapResult {
  rows: NormalizedRow[];
  errors: RowError[];
  skipped: SkippedRow[];
}

/** Column references use header text, or "Column N" (1-based) when the file has no header row. */
export function columnName(index: number): string {
  return `Column ${index + 1}`;
}

function resolveColumn(headers: string[], name: string | null): number | null {
  if (name === null) return null;
  const direct = headers.indexOf(name);
  if (direct >= 0) return direct;
  const lower = name.trim().toLowerCase();
  const loose = headers.findIndex((h) => h.trim().toLowerCase() === lower);
  if (loose >= 0) return loose;
  const positional = /^(?:#|Column\s+)(\d{1,3})$/i.exec(name.trim());
  if (positional) {
    const idx = Number(positional[1]) - 1;
    if (idx >= 0 && idx < Math.max(headers.length, 1000)) return idx;
  }
  return -1;
}

/** Validates that every column referenced by the mapping exists. Returns problems, or an empty list. */
export function checkMappingColumns(headers: string[], mapping: ColumnMapping): string[] {
  const problems: string[] = [];
  const refs: Array<[string, string | null]> = [
    ['dateColumn', mapping.dateColumn],
    ['valueDateColumn', mapping.valueDateColumn],
    ['counterpartyColumn', mapping.counterpartyColumn],
    ['referenceColumn', mapping.referenceColumn],
    ['balanceColumn', mapping.balanceColumn],
    ['currencyColumn', mapping.currencyColumn],
    ['statusColumn', mapping.statusColumn],
    ['categoryColumn', mapping.categoryColumn],
    ...mapping.descriptionColumns.map((c, i) => [`descriptionColumns[${i}]`, c] as [string, string]),
  ];
  if (mapping.amountMode === 'signed' || mapping.amountMode === 'amount_direction') refs.push(['amountColumn', mapping.amountColumn]);
  if (mapping.amountMode === 'debit_credit') refs.push(['debitColumn', mapping.debitColumn], ['creditColumn', mapping.creditColumn]);
  if (mapping.amountMode === 'amount_direction') refs.push(['directionColumn', mapping.directionColumn]);
  for (const [field, name] of refs) {
    const required = ['dateColumn', 'amountColumn', 'debitColumn', 'creditColumn', 'directionColumn', 'descriptionColumns[0]'].includes(field);
    if (name === null) {
      if (required) problems.push(`${field} is required for amount mode ${mapping.amountMode}`);
      continue;
    }
    if (resolveColumn(headers, name) === -1) problems.push(`${field}: column "${truncate(name)}" not found`);
  }
  return problems;
}

/**
 * Applies a column mapping to a parsed table. Every row either becomes a NormalizedRow, an error with its row
 * number, or an explicitly skipped blank row. Duplicate identical rows are preserved.
 */
export function mapTable(table: Table, mapping: ColumnMapping, options: MapOptions = {}): MapResult {
  const timezone = options.timezone ?? mapping.sourceTimezone;
  const defaultCurrency = options.currency ?? mapping.defaultCurrency;
  const fmt: NumberFormat = { decimalSeparator: mapping.decimalSeparator, thousandsSeparator: mapping.thousandsSeparator };
  if (fmt.decimalSeparator === fmt.thousandsSeparator) throw new ValueParseError('Decimal and thousands separators must differ');
  const col = (name: string | null) => resolveColumn(table.headers, name);
  const idx = {
    date: col(mapping.dateColumn),
    valueDate: col(mapping.valueDateColumn),
    description: mapping.descriptionColumns.map((c) => col(c)),
    counterparty: col(mapping.counterpartyColumn),
    reference: col(mapping.referenceColumn),
    balance: col(mapping.balanceColumn),
    currency: col(mapping.currencyColumn),
    status: col(mapping.statusColumn),
    category: col(mapping.categoryColumn),
    amount: col(mapping.amountColumn),
    debit: col(mapping.debitColumn),
    credit: col(mapping.creditColumn),
    direction: col(mapping.directionColumn),
  };
  const debitMarkers = new Set(mapping.debitMarkers.map((m) => m.trim().toLowerCase()).filter(Boolean));
  if (debitMarkers.size === 0) for (const m of ['dr', 'debit', 'd', 'db', 'out']) debitMarkers.add(m);
  const result: MapResult = { rows: [], errors: [], skipped: [] };
  const problems = checkMappingColumns(table.headers, mapping);
  if (problems.length) {
    for (const row of table.rows) result.errors.push({ rowNumber: row.rowNumber, field: null, message: `Mapping error: ${problems.join('; ')}` });
    return result;
  }

  for (const { rowNumber, cells } of table.rows) {
    const cell = (i: number | null): string => (i === null || i < 0 ? '' : (cells[i] ?? '').trim());
    const raw: Record<string, string> = {};
    cells.forEach((value, i) => {
      raw[table.headers[i] ?? columnName(i)] = value;
    });
    if (cells.every((c) => c.trim() === '')) {
      result.skipped.push({ rowNumber, reason: 'blank row' });
      continue;
    }
    const dateText = cell(idx.date);
    const amountCells = [cell(idx.amount), cell(idx.debit), cell(idx.credit)].filter(Boolean);
    if (!dateText && amountCells.length === 0) {
      result.skipped.push({ rowNumber, reason: 'no date and no amount (summary or note row)' });
      continue;
    }
    const fail = (field: string | null, message: string) => result.errors.push({ rowNumber, field, message });
    try {
      let bookedOn: string;
      try {
        bookedOn = parseDateValue(dateText, mapping.dateFormat, timezone);
      } catch (e) {
        fail(mapping.dateColumn, (e as Error).message);
        continue;
      }
      let valueOn: string | null = null;
      if (idx.valueDate !== null && cell(idx.valueDate)) {
        try {
          valueOn = parseDateValue(cell(idx.valueDate), mapping.dateFormat, timezone);
        } catch (e) {
          fail(mapping.valueDateColumn, (e as Error).message);
          continue;
        }
      }
      const amount = computeAmount(mapping, fmt, debitMarkers, cell(idx.amount), cell(idx.debit), cell(idx.credit), cell(idx.direction));
      if ('error' in amount) {
        fail(amount.field, amount.error);
        continue;
      }
      let balance: string | null = null;
      if (idx.balance !== null && cell(idx.balance)) {
        try {
          const parsed = parseAmountValue(cell(idx.balance), fmt);
          if (parsed) balance = parsed.marker === 'DR' ? toDecimalString(new D(parsed.value).abs().negated()) : parsed.marker === 'CR' ? toDecimalString(new D(parsed.value).abs()) : parsed.value;
        } catch (e) {
          fail(mapping.balanceColumn, (e as Error).message);
          continue;
        }
      }
      let currency = defaultCurrency;
      if (idx.currency !== null && cell(idx.currency)) {
        const code = cell(idx.currency).toUpperCase();
        if (!/^[A-Z0-9]{2,10}$/.test(code)) {
          fail(mapping.currencyColumn, `Invalid currency code "${truncate(code)}"`);
          continue;
        }
        currency = code;
      }
      const description = cleanText(
        idx.description
          .map((i) => cell(i))
          .filter(Boolean)
          .join(' | '),
      );
      result.rows.push({
        rowNumber,
        bookedOn,
        valueOn,
        description: description || '(no description)',
        counterparty: cleanText(cell(idx.counterparty), 200) || null,
        reference: cleanText(cell(idx.reference), 200) || null,
        amount: amount.value,
        currency,
        balance,
        pending: isPendingStatus(cell(idx.status)),
        externalId: null,
        categoryHint: cleanText(cell(idx.category), 100) || null,
        raw,
      });
    } catch (e) {
      fail(null, e instanceof ValueParseError ? e.message : 'Row could not be parsed');
    }
  }
  return result;
}

function computeAmount(
  mapping: ColumnMapping,
  fmt: NumberFormat,
  debitMarkers: Set<string>,
  amountCell: string,
  debitCell: string,
  creditCell: string,
  directionCell: string,
): { value: string } | { error: string; field: string | null } {
  const parse = (text: string, field: string | null) => {
    try {
      return { parsed: parseAmountValue(text, fmt) };
    } catch (e) {
      return { error: (e as Error).message, field };
    }
  };
  const applyMarker = (p: ParsedAmount, fallbackNegative: boolean): string => {
    const abs = new D(p.value).abs();
    if (p.marker === 'DR') return toDecimalString(abs.negated());
    if (p.marker === 'CR') return toDecimalString(abs);
    const v = new D(p.value);
    return toDecimalString(fallbackNegative ? v.negated() : v);
  };
  if (mapping.amountMode === 'signed') {
    const r = parse(amountCell, mapping.amountColumn);
    if ('error' in r) return { error: r.error!, field: r.field ?? null };
    if (!r.parsed) return { error: 'Amount is empty', field: mapping.amountColumn };
    return { value: applyMarker(r.parsed, !mapping.negativeIsDebit) };
  }
  if (mapping.amountMode === 'debit_credit') {
    const d = parse(debitCell, mapping.debitColumn);
    if ('error' in d) return { error: d.error!, field: d.field ?? null };
    const c = parse(creditCell, mapping.creditColumn);
    if ('error' in c) return { error: c.error!, field: c.field ?? null };
    const debit = d.parsed && !new D(d.parsed.value).isZero() ? new D(d.parsed.value).abs() : null;
    const credit = c.parsed && !new D(c.parsed.value).isZero() ? new D(c.parsed.value).abs() : null;
    if (debit && credit) return { error: 'Both debit and credit are filled in', field: mapping.debitColumn };
    if (debit) return { value: toDecimalString(debit.negated()) };
    if (credit) return { value: toDecimalString(credit) };
    if (d.parsed || c.parsed) return { value: '0' };
    return { error: 'Neither debit nor credit has a value', field: mapping.debitColumn };
  }
  const r = parse(amountCell, mapping.amountColumn);
  if ('error' in r) return { error: r.error!, field: r.field ?? null };
  if (!r.parsed) return { error: 'Amount is empty', field: mapping.amountColumn };
  if (r.parsed.marker) return { value: applyMarker(r.parsed, false) };
  const direction = directionCell.trim().toLowerCase();
  if (!direction) return { error: 'Direction is empty', field: mapping.directionColumn };
  const abs = new D(r.parsed.value).abs();
  return { value: toDecimalString(debitMarkers.has(direction) ? abs.negated() : abs) };
}

export interface DerivedBalances {
  opening: string | null;
  closing: string | null;
  order: 'chronological' | 'reverse' | 'unknown';
}

/**
 * Derives statement opening/closing balances from a running-balance column. Tries both row orders and uses the
 * one where every running balance equals the previous balance plus the row amount. Returns nulls when neither
 * order is consistent; it never guesses.
 */
export function deriveStatementBalances(rows: readonly NormalizedRow[]): DerivedBalances {
  const withBalance = rows.filter((r) => !r.pending);
  if (withBalance.length === 0 || withBalance.some((r) => r.balance === null)) return { opening: null, closing: null, order: 'unknown' };
  const consistent = (list: readonly NormalizedRow[]) => {
    for (let i = 1; i < list.length; i += 1) {
      if (!new D(list[i - 1]!.balance!).plus(list[i]!.amount).equals(new D(list[i]!.balance!))) return false;
    }
    return true;
  };
  const forward = consistent(withBalance);
  const reversed = [...withBalance].reverse();
  const backward = consistent(reversed);
  const pick = forward && (!backward || withBalance[0]!.bookedOn <= withBalance[withBalance.length - 1]!.bookedOn) ? withBalance : backward ? reversed : null;
  if (!pick) return { opening: null, closing: null, order: 'unknown' };
  const first = pick[0]!;
  const last = pick[pick.length - 1]!;
  return {
    opening: toDecimalString(new D(first.balance!).minus(first.amount)),
    closing: last.balance,
    order: pick === withBalance ? 'chronological' : 'reverse',
  };
}

export function coverageOf(rows: ReadonlyArray<{ bookedOn: string }>): { from: string | null; to: string | null } {
  let from: string | null = null;
  let to: string | null = null;
  for (const r of rows) {
    if (from === null || r.bookedOn < from) from = r.bookedOn;
    if (to === null || r.bookedOn > to) to = r.bookedOn;
  }
  return { from, to };
}
