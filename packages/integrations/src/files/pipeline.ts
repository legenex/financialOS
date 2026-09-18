import type { ColumnMapping, FileCheck, ImportFileKind, Money } from '@financialos/contracts';
import { D, toDecimalString } from '@financialos/domain';
import { FileParseError, FileRejectedError } from '../core/errors';
import type { CoverageInfo } from '../core/records';
import { CSV_PARSER_VERSION, parseCsvText, suggestMapping, type MappingSuggestion } from './csv';
import { IBKR_FLEX_PARSER_VERSION, parseFlexCsv, parseFlexXml, type FlexStatementResult } from './ibkrFlex';
import { coverageOf, deriveStatementBalances, mapTable, type NormalizedRow, type RowError, type SkippedRow } from './normalize';
import { OFX_PARSER_VERSION, parseOfx, type OfxStatement } from './ofx';
import { PDF_PARSER_VERSION, extractPdfLines, parseStatementText, type RowConfidence } from './pdf';
import { sniffFile } from './sniff';
import { XLSX_PARSER_VERSION, localiseTypedNumbers, readXlsx } from './xlsx';

export const PARSER_VERSIONS = {
  csv: CSV_PARSER_VERSION,
  xlsx: XLSX_PARSER_VERSION,
  ofx: OFX_PARSER_VERSION,
  ibkr_flex: IBKR_FLEX_PARSER_VERSION,
  pdf_text: PDF_PARSER_VERSION,
} as const;

export interface ParseFileOptions {
  kind: ImportFileKind;
  /** Required for csv/xlsx rows (null returns headers, samples, and a suggested mapping only). Used for number/date settings with pdf. */
  mapping: ColumnMapping | null;
  timezone: string;
  currency: string;
  /** When given, content checks are repeated before parsing. */
  fileName?: string;
  declaredMime?: string | null;
  /** OFX files can hold several accounts; pick one by its masked identifier. */
  accountMask?: string | null;
  /** PDF: year for rows printed without one. */
  statementYear?: number | null;
  pdfUnsignedMeans?: 'debit' | 'credit' | 'unknown';
  signal?: AbortSignal;
  pdfTimeoutMs?: number;
}

export interface ParseFileResult {
  parser: keyof typeof PARSER_VERSIONS;
  parserVersion: string;
  rows: NormalizedRow[];
  errors: RowError[];
  skipped: SkippedRow[];
  coverage: CoverageInfo;
  statementBalances: { opening: Money | null; closing: Money | null; closingAsOf: string | null };
  detectedHeaders: string[];
  sampleRows: string[][];
  headerFingerprint: string | null;
  suggestion: MappingSuggestion | null;
  checks: FileCheck[];
  /** True when the owner must review before commit (low-confidence PDF rows, truncated input, ambiguous data). */
  requiresReview: boolean;
  reviewReasons: string[];
  notes: string[];
  /** Per-row confidence for text-extracted rows. */
  rowConfidence: Record<number, RowConfidence> | null;
  ofx: { statements: Array<Omit<OfxStatement, 'rows'> & { rowCount: number }> } | null;
  investment: { statements: FlexStatementResult[] } | null;
}

const SAMPLE_ROWS = 10;

function money(amount: string | null, currency: string): Money | null {
  return amount === null ? null : { amount, currency };
}

function emptyResult(parser: ParseFileResult['parser'], checks: FileCheck[]): ParseFileResult {
  return {
    parser,
    parserVersion: PARSER_VERSIONS[parser],
    rows: [],
    errors: [],
    skipped: [],
    coverage: { from: null, to: null, note: null },
    statementBalances: { opening: null, closing: null, closingAsOf: null },
    detectedHeaders: [],
    sampleRows: [],
    headerFingerprint: null,
    suggestion: null,
    checks,
    requiresReview: false,
    reviewReasons: [],
    notes: [],
    rowConfidence: null,
    ofx: null,
    investment: null,
  };
}

function finishTabular(result: ParseFileResult, rows: NormalizedRow[], currency: string): void {
  const derived = deriveStatementBalances(rows);
  result.statementBalances = { opening: money(derived.opening, currency), closing: money(derived.closing, currency), closingAsOf: null };
  if (rows.some((r) => r.balance !== null) && derived.order === 'unknown') {
    result.notes.push('The running balance column is not consistent with the amounts in either row order; statement balances were not derived.');
  }
  const cov = coverageOf(rows);
  result.coverage = { from: cov.from, to: cov.to, note: 'Coverage is the first and last transaction date in the file.' };
  if (rows.some((r) => r.currency !== currency)) result.notes.push('Rows use more than one currency.');
}

/**
 * Parses an import file into normalised rows. Every problem row is reported with its row number; nothing is
 * dropped silently. The result never contains ledger entries: the worker decides what to commit.
 */
export async function parseFile(bytes: Uint8Array, options: ParseFileOptions): Promise<ParseFileResult> {
  let checks: FileCheck[] = [];
  let sniffedText: string | null = null;
  if (options.fileName) {
    const sniff = sniffFile({ bytes, fileName: options.fileName, declaredMime: options.declaredMime ?? null });
    checks = sniff.checks;
    if (!sniff.ok) throw new FileRejectedError('The file failed safety checks', sniff.checks);
    const compatible: Record<ImportFileKind, ImportFileKind[]> = {
      csv: ['csv', 'ibkr_flex_csv'],
      ibkr_flex_csv: ['ibkr_flex_csv', 'csv'],
      xlsx: ['xlsx'],
      ofx: ['ofx', 'qfx'],
      qfx: ['qfx', 'ofx'],
      ibkr_flex_xml: ['ibkr_flex_xml'],
      pdf: ['pdf'],
    };
    if (!sniff.kind || !compatible[options.kind].includes(sniff.kind)) {
      throw new FileRejectedError(`The file content (${sniff.kind ?? 'unknown'}) does not match the selected type ${options.kind}`, [
        ...sniff.checks,
        { check: 'kind_match', passed: false, detail: `Detected ${sniff.kind ?? 'unknown'}, selected ${options.kind}` },
      ]);
    }
    sniffedText = sniff.text;
  }
  const textOf = () => {
    if (sniffedText !== null) return sniffedText;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  };

  switch (options.kind) {
    case 'csv': {
      const mapping = options.mapping;
      const parsed = parseCsvText(textOf(), { delimiter: mapping?.delimiter ?? null, skipRows: mapping?.skipRows ?? 0, hasHeader: mapping ? mapping.hasHeader : null });
      const result = emptyResult('csv', checks);
      result.detectedHeaders = parsed.headers;
      result.sampleRows = parsed.rows.slice(0, SAMPLE_ROWS).map((r) => r.cells);
      result.headerFingerprint = parsed.headerFingerprint;
      result.errors.push(...parsed.structuralErrors.map((e) => ({ rowNumber: e.rowNumber, field: null, message: e.message })));
      if (parsed.truncated) {
        result.requiresReview = true;
        result.reviewReasons.push('The file has more rows than the import limit; only the first rows were read.');
      }
      if (!mapping) {
        result.suggestion = suggestMapping(parsed.headers, result.sampleRows, {
          defaultCurrency: options.currency,
          timezone: options.timezone,
          delimiter: parsed.delimiter,
          hasHeader: parsed.hasHeader,
        });
        return result;
      }
      const mapped = mapTable(parsed, mapping, { timezone: options.timezone, currency: options.currency });
      result.rows = mapped.rows;
      result.errors.push(...mapped.errors);
      result.skipped = mapped.skipped;
      finishTabular(result, mapped.rows, options.currency);
      return result;
    }
    case 'xlsx': {
      const mapping = options.mapping;
      const parsed = await readXlsx(bytes, { sheetName: mapping?.sheetName ?? null, skipRows: mapping?.skipRows ?? 0, hasHeader: mapping ? mapping.hasHeader : null });
      const result = emptyResult('xlsx', checks);
      result.detectedHeaders = parsed.headers;
      result.sampleRows = parsed.rows.slice(0, SAMPLE_ROWS).map((r) => r.cells);
      result.headerFingerprint = parsed.headerFingerprint;
      result.notes.push(`Worksheet: ${parsed.sheetName} (of ${parsed.sheetNames.length})`);
      if (parsed.truncated) {
        result.requiresReview = true;
        result.reviewReasons.push('The worksheet has more rows than the import limit; only the first rows were read.');
      }
      if (!mapping) {
        result.suggestion = suggestMapping(parsed.headers, result.sampleRows, { defaultCurrency: options.currency, timezone: options.timezone, hasHeader: parsed.hasHeader });
        return result;
      }
      const table = localiseTypedNumbers(parsed, mapping.decimalSeparator);
      const mapped = mapTable(table, mapping, { timezone: options.timezone, currency: options.currency });
      result.rows = mapped.rows;
      result.errors.push(...mapped.errors);
      result.skipped = mapped.skipped;
      finishTabular(result, mapped.rows, options.currency);
      return result;
    }
    case 'ofx':
    case 'qfx': {
      const parsed = parseOfx(textOf(), { timezone: options.timezone, defaultCurrency: options.currency });
      const result = emptyResult('ofx', checks);
      result.errors.push(...parsed.errors);
      const withRows = parsed.statements.filter((s) => s.rows.length > 0 || s.kind !== 'investment');
      let chosen: OfxStatement | undefined;
      if (options.accountMask) chosen = parsed.statements.find((s) => s.accountMask === options.accountMask);
      else if (withRows.length === 1) chosen = withRows[0];
      result.ofx = { statements: parsed.statements.map(({ rows, ...rest }) => ({ ...rest, rowCount: rows.length })) };
      result.detectedHeaders = ['DTPOSTED', 'NAME', 'MEMO', 'TRNAMT', 'FITID', 'TRNTYPE'];
      if (!chosen) {
        if (parsed.statements.length > 1) {
          result.requiresReview = true;
          result.reviewReasons.push('The OFX file contains several accounts. Choose one by its masked number.');
          return result;
        }
        chosen = parsed.statements[0];
      }
      if (!chosen) throw new FileParseError('The OFX file has no statement');
      result.rows = chosen.rows;
      result.sampleRows = chosen.rows.slice(0, SAMPLE_ROWS).map((r) => [r.bookedOn, r.description, r.amount, r.externalId ?? '']);
      const cov = coverageOf(chosen.rows);
      result.coverage = {
        from: chosen.period.from ?? cov.from,
        to: chosen.period.to ?? cov.to,
        note: chosen.period.from ? 'Coverage is the statement period stated in the file (DTSTART–DTEND).' : 'Coverage is the first and last transaction date.',
      };
      const closing = chosen.ledgerBalance;
      result.statementBalances = { opening: null, closing: closing ? { amount: closing.amount, currency: chosen.currency } : null, closingAsOf: closing?.asOf?.instant ?? closing?.asOf?.date ?? null };
      if (chosen.kind === 'investment') {
        result.notes.push('Investment statement: positions and trades are returned separately from cash rows.');
      }
      const dupFitids = chosen.rows.map((r) => r.externalId).filter((id, i, arr) => id !== null && arr.indexOf(id) !== i);
      if (dupFitids.length) result.notes.push(`${dupFitids.length} transaction(s) reuse a FITID; they are kept and flagged by the duplicate check.`);
      return result;
    }
    case 'ibkr_flex_xml':
    case 'ibkr_flex_csv': {
      const parsed = options.kind === 'ibkr_flex_xml' ? parseFlexXml(textOf()) : parseFlexCsv(textOf());
      const result = emptyResult('ibkr_flex', checks);
      result.errors.push(...parsed.errors);
      result.investment = { statements: parsed.statements };
      const rows: NormalizedRow[] = [];
      let n = 0;
      for (const s of parsed.statements) {
        for (const tx of [...s.investmentTransactions, ...s.cashMovements]) {
          n += 1;
          const net = tx.netAmount ?? tx.grossAmount;
          if (net === null) continue;
          rows.push({
            rowNumber: n,
            bookedOn: tx.tradeDate,
            valueOn: tx.settleDate,
            description: tx.symbol ? `${tx.kind.replace(/_/g, ' ')} ${tx.symbol} — ${tx.description}` : tx.description,
            counterparty: null,
            reference: tx.externalId,
            amount: net,
            currency: tx.currency,
            balance: null,
            pending: false,
            externalId: tx.externalId,
            categoryHint: tx.kind,
            raw: { kind: tx.kind, account: s.externalAccountId },
          });
        }
        result.notes.push(...s.notes);
      }
      result.rows = rows;
      result.detectedHeaders = [...new Set(parsed.statements.flatMap((s) => s.sectionsPresent))];
      result.sampleRows = rows.slice(0, SAMPLE_ROWS).map((r) => [r.bookedOn, r.description, r.amount, r.currency]);
      const first = parsed.statements[0];
      const froms = parsed.statements.map((s) => s.coverage.from).filter((d): d is string => d !== null).sort();
      const tos = parsed.statements.map((s) => s.coverage.to).filter((d): d is string => d !== null).sort();
      result.coverage = { from: froms[0] ?? null, to: tos[tos.length - 1] ?? null, note: first?.coverage.note ?? 'Coverage is the Flex statement period.' };
      if (parsed.statements.length > 1) {
        result.requiresReview = true;
        result.reviewReasons.push('The Flex file contains several accounts; map each account before committing.');
      }
      return result;
    }
    case 'pdf': {
      const extraction = await extractPdfLines(bytes, { signal: options.signal, timeoutMs: options.pdfTimeoutMs });
      const mapping = options.mapping;
      const parsed = parseStatementText(extraction.lines, {
        dateFormat: mapping?.dateFormat ?? 'DD/MM/YYYY',
        decimalSeparator: mapping?.decimalSeparator ?? '.',
        thousandsSeparator: mapping?.thousandsSeparator ?? ',',
        currency: options.currency,
        timezone: options.timezone,
        defaultYear: options.statementYear ?? null,
        unsignedMeans: options.pdfUnsignedMeans ?? 'unknown',
      });
      const result = emptyResult('pdf_text', checks);
      result.rows = parsed.rows.map(({ confidence: _c, page: _p, ...row }) => row);
      result.rowConfidence = Object.fromEntries(parsed.rows.map((r) => [r.rowNumber, r.confidence]));
      result.errors = parsed.errors;
      result.detectedHeaders = ['date', 'description', 'amount', 'balance'];
      result.sampleRows = extraction.lines.slice(0, SAMPLE_ROWS).map((l) => l.cells.map((c) => c.text));
      result.statementBalances = { opening: money(parsed.opening, options.currency), closing: money(parsed.closing, options.currency), closingAsOf: null };
      const cov = coverageOf(parsed.rows);
      result.coverage = { from: cov.from, to: cov.to, note: 'Coverage is the first and last transaction date found in the PDF text.' };
      result.requiresReview = parsed.requiresReview;
      result.reviewReasons = parsed.reviewReasons;
      result.notes.push(`Read ${extraction.pagesRead} page(s); ${parsed.unparsedLines} line(s) were not transaction rows. Document confidence: ${parsed.documentConfidence}.`);
      if (parsed.opening !== null && parsed.closing !== null) {
        const expected = parsed.rows.reduce((acc, r) => acc.plus(r.amount), new D(parsed.opening));
        result.notes.push(`Opening + movements = ${toDecimalString(expected)}; stated closing = ${parsed.closing}.`);
      }
      return result;
    }
    default: {
      const never: never = options.kind;
      throw new FileParseError(`Unsupported file kind ${String(never)}`);
    }
  }
}
