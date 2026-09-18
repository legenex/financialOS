import { ImportLimits, type DateFormat } from '@financialos/contracts';
import { D, toDecimalString } from '@financialos/domain';
import { FileParseError, OperationTimeoutError } from '../core/errors';
import { cleanText, parseAmountValue, parseDateValue, type NormalizedRow, type NumberFormat, type RowError } from './normalize';

export const PDF_PARSER_VERSION = '1.0.0';

/**
 * Native PDF text extraction. Document text is treated strictly as data: it is never interpreted as
 * instructions, never executed, and never forwarded to a model by this module.
 */
export const pdfCapabilities = {
  textExtraction: true,
  ocrAvailable: false,
  ocrReason:
    'OCR is not installed on this deployment. Scanned (image-only) statements cannot be read; download the statement as CSV or OFX, or as a text-based PDF.',
} as const;

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfLine {
  page: number;
  /** Baseline y in PDF user space (origin bottom-left). */
  y: number;
  text: string;
  cells: Array<{ text: string; x: number; xEnd: number }>;
}

export interface PdfExtractOptions {
  maxPages?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PdfExtraction {
  pageCount: number;
  pagesRead: number;
  lines: PdfLine[];
  textCharacters: number;
}

/** Groups positioned text items into visual lines and cells. */
export function groupTextItems(page: number, items: readonly PdfTextItem[]): PdfLine[] {
  const usable = items.filter((i) => i.str.trim() !== '');
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Array<{ y: number; items: PdfTextItem[] }> = [];
  for (const item of sorted) {
    const tolerance = Math.max(2, (item.height || 10) * 0.4);
    const row = rows.find((r) => Math.abs(r.y - item.y) <= tolerance);
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => {
      const ordered = row.items.sort((a, b) => a.x - b.x);
      const cells: PdfLine['cells'] = [];
      for (const item of ordered) {
        const last = cells[cells.length - 1];
        const charWidth = item.str.length > 0 && item.width > 0 ? item.width / item.str.length : (item.height || 10) * 0.5;
        const gap = last ? item.x - last.xEnd : Infinity;
        if (last && gap <= Math.max(charWidth * 1.5, 3)) {
          last.text += (gap > charWidth * 0.3 ? ' ' : '') + item.str;
          last.xEnd = item.x + item.width;
        } else {
          cells.push({ text: item.str, x: item.x, xEnd: item.x + item.width });
        }
      }
      const cleaned = cells.map((c) => ({ ...c, text: cleanText(c.text, 1000) })).filter((c) => c.text !== '');
      return { page, y: row.y, text: cleaned.map((c) => c.text).join('  '), cells: cleaned };
    });
}

/** Extracts positioned text with pdf.js (via unpdf): no script evaluation, no font loading, no network. */
export async function extractPdfLines(bytes: Uint8Array, options: PdfExtractOptions = {}): Promise<PdfExtraction> {
  const maxPages = Math.min(options.maxPages ?? ImportLimits.maxPdfPages, ImportLimits.maxPdfPages);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const { getDocumentProxy, resolvePDFJSImport } = await import('unpdf');
  await resolvePDFJSImport();
  const init = {
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    fontExtraProperties: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    enableXfa: false,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: false,
    maxImageSize: 1,
    verbosity: 0,
  };
  // pdf.js may take ownership of the buffer, so it receives a copy.
  const data = new Uint8Array(bytes);
  let destroy: (() => Promise<void>) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    const pdf = await getDocumentProxy(data, init as Parameters<typeof getDocumentProxy>[1]);
    destroy = () => pdf.loadingTask.destroy();
    if (pdf.numPages > maxPages) throw new FileParseError(`The PDF has ${pdf.numPages} pages; the limit is ${maxPages}`);
    const lines: PdfLine[] = [];
    let chars = 0;
    for (let p = 1; p <= pdf.numPages; p += 1) {
      if (options.signal?.aborted) throw new OperationTimeoutError('PDF extraction was cancelled');
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const raw of content.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>) {
        if (typeof raw.str !== 'string' || !raw.transform) continue;
        chars += raw.str.replace(/\s/g, '').length;
        items.push({ str: raw.str, x: raw.transform[4] ?? 0, y: raw.transform[5] ?? 0, width: raw.width ?? 0, height: raw.height ?? Math.hypot(raw.transform[2] ?? 0, raw.transform[3] ?? 0) });
      }
      lines.push(...groupTextItems(p, items));
      page.cleanup();
    }
    return { pageCount: pdf.numPages, pagesRead: pdf.numPages, lines, textCharacters: chars };
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(`PDF extraction exceeded ${timeoutMs} ms`)), timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    options.signal?.addEventListener('abort', () => reject(new OperationTimeoutError('PDF extraction was cancelled')), { once: true });
  });
  try {
    const result = await Promise.race([work, timeout, aborted]);
    if (result.textCharacters < 20) {
      throw new FileParseError(`This PDF has no usable text layer (it looks scanned). ${pdfCapabilities.ocrReason}`);
    }
    return result;
  } catch (err) {
    if (err instanceof FileParseError || err instanceof OperationTimeoutError) throw err;
    throw new FileParseError('The PDF could not be read. Download the statement again or use CSV/OFX.');
  } finally {
    clearTimeout(timer);
    const d = destroy as (() => Promise<void>) | null;
    if (d) await d().catch(() => undefined);
    work.catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Generic statement text parser
// ---------------------------------------------------------------------------------------------------------

export type RowConfidence = 'high' | 'medium' | 'low';

export interface PdfStatementRow extends NormalizedRow {
  confidence: RowConfidence;
  page: number;
}

export interface StatementTextOptions extends NumberFormat {
  dateFormat: DateFormat;
  currency: string;
  timezone: string;
  /** Year to use for rows printed without one ("05 Jan"). */
  defaultYear?: number | null;
  /** How to sign amounts that carry no sign, marker, or column hint and cannot be derived from balances. */
  unsignedMeans?: 'debit' | 'credit' | 'unknown';
}

export interface StatementTextResult {
  rows: PdfStatementRow[];
  errors: RowError[];
  opening: string | null;
  closing: string | null;
  documentConfidence: RowConfidence;
  requiresReview: boolean;
  reviewReasons: string[];
  unparsedLines: number;
}

const DATE_TOKEN: Record<string, string> = {
  'YYYY-MM-DD': String.raw`\d{4}-\d{1,2}-\d{1,2}`,
  'YYYY/MM/DD': String.raw`\d{4}/\d{1,2}/\d{1,2}`,
  'DD/MM/YYYY': String.raw`\d{1,2}/\d{1,2}/\d{4}`,
  'MM/DD/YYYY': String.raw`\d{1,2}/\d{1,2}/\d{4}`,
  'DD-MM-YYYY': String.raw`\d{1,2}-\d{1,2}-\d{4}`,
  'DD.MM.YYYY': String.raw`\d{1,2}\.\d{1,2}\.\d{4}`,
  'D MMM YYYY': String.raw`\d{1,2}[ -][A-Za-z]{3,9}\.?(?:[ -]\d{4})?`,
  'MMM D, YYYY': String.raw`[A-Za-z]{3,9}\.? \d{1,2}(?:,? \d{4})?`,
  YYYYMMDD: String.raw`\d{8}`,
  iso_datetime: String.raw`\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?`,
  excel_serial: String.raw`\d{5}`,
};

const AMOUNT_TOKEN = String.raw`\(?-?[A-Z]{0,3}\s?[$€£R]?\s?-?\d{1,3}(?:[,. '\u00A0]?\d{3})*(?:[.,]\d{1,2})?\)?-?(?:\s?(?:CR|DR|Cr|Dr))?`;
const OPENING = /\b(opening balance|balance brought forward|brought forward|balance b\/f|previous balance)\b/i;
const CLOSING = /\b(closing balance|balance carried forward|carried forward|balance c\/f|new balance)\b/i;
const DEBIT_HEADER = /\b(debits?|money out|paid out|withdrawals?|payments?)\b/i;
const CREDIT_HEADER = /\b(credits?|money in|paid in|deposits?|receipts?)\b/i;
const BALANCE_HEADER = /\bbalance\b/i;

function signed(value: string, marker: 'CR' | 'DR' | null): { amount: string; explicit: boolean } {
  const d = new D(value);
  if (marker === 'DR') return { amount: toDecimalString(d.abs().negated()), explicit: true };
  if (marker === 'CR') return { amount: toDecimalString(d.abs()), explicit: true };
  return { amount: toDecimalString(d), explicit: d.isNegative() };
}

/**
 * Generic statement line parser: finds rows that start with a date and end with one or more amounts, plus
 * opening/closing balance lines. Signs come from explicit markers, debit/credit column positions, or the
 * running balance; anything else is flagged low confidence and the batch requires owner review.
 */
export function parseStatementText(lines: readonly PdfLine[], options: StatementTextOptions): StatementTextResult {
  const fmt: NumberFormat = { decimalSeparator: options.decimalSeparator, thousandsSeparator: options.thousandsSeparator };
  const dateRe = new RegExp(`^(${DATE_TOKEN[options.dateFormat] ?? DATE_TOKEN['YYYY-MM-DD']})\\b\\s*(.*)$`);
  const trailingAmounts = new RegExp(`(?:\\s+|^)(${AMOUNT_TOKEN})\\s*$`);
  const rows: PdfStatementRow[] = [];
  const errors: RowError[] = [];
  const reasons = new Set<string>();
  let opening: string | null = null;
  let closing: string | null = null;
  let previousBalance: string | null = null;
  let unparsed = 0;
  let lastRowIndex = -2;
  let columns: { debit: number | null; credit: number | null; balance: number | null } | null = null;

  const parseAmountSafe = (token: string) => {
    try {
      return parseAmountValue(token, fmt);
    } catch {
      return null;
    }
  };
  const peelAmounts = (body: string): { rest: string; amounts: string[] } => {
    const amounts: string[] = [];
    let rest = body;
    for (let k = 0; k < 3; k += 1) {
      const m = trailingAmounts.exec(rest);
      if (!m || !/\d/.test(m[1]!) || parseAmountSafe(m[1]!) === null) break;
      amounts.unshift(m[1]!.trim());
      rest = rest.slice(0, m.index).trimEnd();
    }
    return { rest, amounts };
  };
  const resolveDate = (token: string): string => {
    if (options.dateFormat === 'D MMM YYYY' && !/\d{4}$/.test(token)) {
      if (!options.defaultYear) throw new FileParseError('Row date has no year; set the statement year');
      return parseDateValue(`${token} ${options.defaultYear}`, 'D MMM YYYY', options.timezone);
    }
    if (options.dateFormat === 'MMM D, YYYY' && !/\d{4}$/.test(token)) {
      if (!options.defaultYear) throw new FileParseError('Row date has no year; set the statement year');
      return parseDateValue(`${token}, ${options.defaultYear}`, 'MMM D, YYYY', options.timezone);
    }
    return parseDateValue(token, options.dateFormat, options.timezone);
  };

  lines.forEach((line, index) => {
    const rowNumber = index + 1;
    const text = line.text;
    if (DEBIT_HEADER.test(text) && CREDIT_HEADER.test(text) && !/\d{2}/.test(text)) {
      const find = (re: RegExp) => line.cells.find((c) => re.test(c.text));
      const center = (c: { x: number; xEnd: number } | undefined) => (c ? (c.x + c.xEnd) / 2 : null);
      columns = { debit: center(find(DEBIT_HEADER)), credit: center(find(CREDIT_HEADER)), balance: center(find(BALANCE_HEADER)) };
      return;
    }
    const isOpening = OPENING.test(text);
    const isClosing = CLOSING.test(text);
    if (isOpening || isClosing) {
      const { amounts } = peelAmounts(text);
      const last = amounts[amounts.length - 1];
      const parsed = last ? parseAmountSafe(last) : null;
      if (parsed) {
        const value = signed(parsed.value, parsed.marker).amount;
        if (isOpening && opening === null) {
          opening = value;
          previousBalance = value;
        } else if (isClosing) {
          closing = value;
        }
        return;
      }
    }
    const dm = dateRe.exec(text);
    if (!dm) {
      // Continuation lines extend the previous description (bounded); everything else is counted.
      const prev = rows[rows.length - 1];
      if (prev && prev.page === line.page && lastRowIndex === index - 1 && !/\d+[.,]\d{2}\b/.test(text) && text.length < 120) {
        prev.description = cleanText(`${prev.description} ${text}`);
        lastRowIndex = index;
        return;
      }
      unparsed += 1;
      return;
    }
    let bookedOn: string;
    try {
      bookedOn = resolveDate(dm[1]!);
    } catch (e) {
      errors.push({ rowNumber, field: 'date', message: e instanceof Error ? e.message : 'Invalid date' });
      return;
    }
    const { rest, amounts } = peelAmounts(dm[2] ?? '');
    if (amounts.length === 0) {
      unparsed += 1;
      return;
    }
    const parsedAmounts = amounts.map((a) => parseAmountSafe(a)!);
    let amountToken = parsedAmounts[0]!;
    let balance: string | null = null;
    let confidence: RowConfidence = 'low';
    let amount: string | null = null;
    if (parsedAmounts.length >= 2) {
      const balanceToken = parsedAmounts[parsedAmounts.length - 1]!;
      balance = signed(balanceToken.value, balanceToken.marker).amount;
      amountToken = parsedAmounts[parsedAmounts.length - 2]!;
    }
    const s = signed(amountToken.value, amountToken.marker);
    if (s.explicit) {
      amount = s.amount;
      confidence = 'high';
    }
    if (balance !== null && previousBalance !== null) {
      const abs = new D(amountToken.value).abs();
      const prev = new D(previousBalance);
      const asCredit = prev.plus(abs).equals(balance);
      const asDebit = prev.minus(abs).equals(balance);
      if (amount !== null) {
        if (!prev.plus(amount).equals(balance)) {
          confidence = 'low';
          reasons.add('Some running balances do not match the row amounts.');
        }
      } else if (asCredit !== asDebit) {
        amount = toDecimalString(asCredit ? abs : abs.negated());
        confidence = 'high';
      }
    }
    if (amount === null && columns) {
      const cols = columns as { debit: number | null; credit: number | null };
      const amountCell = line.cells.slice().reverse().find((c) => c.text.replace(/\s/g, '').includes(amounts[parsedAmounts.length >= 2 ? amounts.length - 2 : 0]!.replace(/\s/g, '')));
      if (amountCell && cols.debit !== null && cols.credit !== null) {
        const center = (amountCell.x + amountCell.xEnd) / 2;
        const isDebit = Math.abs(center - cols.debit) < Math.abs(center - cols.credit);
        const abs = new D(amountToken.value).abs();
        amount = toDecimalString(isDebit ? abs.negated() : abs);
        confidence = 'medium';
      }
    }
    if (amount === null) {
      const abs = new D(amountToken.value).abs();
      if (options.unsignedMeans === 'debit') amount = toDecimalString(abs.negated());
      else if (options.unsignedMeans === 'credit') amount = toDecimalString(abs);
      else {
        errors.push({ rowNumber, field: 'amount', message: 'Could not tell whether the amount is a debit or a credit' });
        return;
      }
      confidence = 'low';
      reasons.add('Some amounts had no sign and were signed by the configured default.');
    }
    if (parsedAmounts.length > 2) {
      confidence = confidence === 'high' ? 'medium' : confidence;
      reasons.add('Some rows had more than two amounts; check the debit/credit columns.');
    }
    if (balance !== null) previousBalance = balance;
    lastRowIndex = index;
    rows.push({
      rowNumber,
      page: line.page,
      bookedOn,
      valueOn: null,
      description: cleanText(rest) || '(no description)',
      counterparty: null,
      reference: null,
      amount,
      currency: options.currency,
      balance,
      pending: false,
      externalId: null,
      categoryHint: null,
      raw: { page: String(line.page), line: text },
      confidence,
    });
  });

  if (rows.length === 0) reasons.add('No transaction rows were recognised.');
  const low = rows.filter((r) => r.confidence === 'low').length;
  const medium = rows.filter((r) => r.confidence === 'medium').length;
  if (errors.length) reasons.add(`${errors.length} line(s) could not be parsed.`);
  let reconciled = false;
  if (opening !== null && closing !== null) {
    const total = rows.reduce((acc, r) => acc.plus(r.amount), new D(opening));
    reconciled = total.equals(closing);
    if (!reconciled) reasons.add('Opening balance plus transactions does not equal the closing balance.');
  } else {
    reasons.add('The statement opening and closing balances were not both found.');
  }
  const documentConfidence: RowConfidence = rows.length === 0 || low > 0 || errors.length > 0 ? 'low' : medium > 0 || !reconciled ? 'medium' : 'high';
  return {
    rows,
    errors,
    opening,
    closing,
    documentConfidence,
    requiresReview: documentConfidence !== 'high' || reasons.size > 0,
    reviewReasons: [...reasons],
    unparsedLines: unparsed,
  };
}
