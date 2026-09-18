import { XMLParser } from 'fast-xml-parser';
import Papa from 'papaparse';
import { D, makeDate, toDecimalString } from '@financialos/domain';
import { FileParseError } from '../core/errors';
import type {
  CoverageInfo,
  InvestmentTransactionKind,
  NormalizedCashBalance,
  NormalizedCorporateAction,
  NormalizedFxRate,
  NormalizedHoldingLine,
  NormalizedHoldingsSnapshot,
  NormalizedInvestmentTransaction,
} from '../core/records';
import { maskIdentifier } from '../core/redact';
import { cleanText, type RowError } from './normalize';

export const IBKR_FLEX_PARSER_VERSION = '1.0.0';
export const IBKR_FLEX_SOURCE = 'IBKR Flex';

/**
 * Interactive Brokers Activity Flex Query parser (XML and multi-section CSV).
 *
 * Element and attribute names follow the Flex XML output as commonly produced (FlexQueryResponse >
 * FlexStatements > FlexStatement with OpenPositions, Trades, CashTransactions, CorporateActions, CashReport,
 * ConversionRates, AccountInformation). IBKR's public guides list display names only, so names are matched
 * case-insensitively with CSV synonyms, and unknown sections are ignored rather than guessed.
 */

export interface FlexStatementResult {
  externalAccountId: string;
  accountMask: string | null;
  baseCurrency: string | null;
  coverage: CoverageInfo;
  generatedAt: string | null;
  sectionsPresent: string[];
  investmentTransactions: NormalizedInvestmentTransaction[];
  cashMovements: NormalizedInvestmentTransaction[];
  holdings: NormalizedHoldingsSnapshot | null;
  cashBalances: NormalizedCashBalance[];
  fxRates: NormalizedFxRate[];
  corporateActions: NormalizedCorporateAction[];
  notes: string[];
}

export interface FlexParseResult {
  format: 'xml' | 'csv';
  statements: FlexStatementResult[];
  errors: RowError[];
  parserVersion: string;
}

type Attrs = Record<string, string>;

function lowerKeys(record: Record<string, unknown>): Attrs {
  const out: Attrs = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k.toLowerCase()] = String(v);
  }
  return out;
}

const CSV_SYNONYMS: Record<string, string> = {
  clientaccountid: 'accountid',
  currencyprimary: 'currency',
  assetclass: 'assetcategory',
  fxratetobase: 'fxratetobase',
  quantity: 'quantity',
  ibcommission: 'ibcommission',
  tradeid: 'tradeid',
  transactionid: 'transactionid',
};

function normaliseCsvRecord(record: Attrs): Attrs {
  const out: Attrs = {};
  for (const [k, v] of Object.entries(record)) {
    const key = k.toLowerCase().replace(/[^a-z0-9]/g, '');
    out[CSV_SYNONYMS[key] ?? key] = v;
  }
  return out;
}

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXmlText(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (m, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)));
    return PREDEFINED[body] ?? m;
  });
}

function text(a: Attrs, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = a[k];
    if (v !== undefined && v.trim() !== '' && v.trim() !== '--') return decodeXmlText(v.trim());
  }
  return null;
}

function decimal(a: Attrs, ...keys: string[]): string | null {
  const v = text(a, ...keys);
  if (v === null) return null;
  const clean = v.replace(/,/g, '');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(clean)) throw new FileParseError(`Invalid number in field ${keys[0]}`);
  return toDecimalString(new D(clean));
}

/** Parses IBKR date values: yyyyMMdd, yyyy-MM-dd, optionally followed by a time (";", " ", ",", or "T" separated). */
export function parseFlexDate(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})(?:[;, T]\d{2}:?\d{2}(?::?\d{2})?)?$/.exec(v);
  if (!m) m = /^(\d{4})-(\d{2})-(\d{2})(?:[;, T]\d{2}:?\d{2}(?::?\d{2})?)?$/.exec(v);
  if (!m) throw new FileParseError(`Unrecognised IBKR date "${v.slice(0, 30)}" (configure the Flex query to use yyyyMMdd)`);
  try {
    return makeDate(Number(m[1]), Number(m[2]), Number(m[3]));
  } catch {
    throw new FileParseError(`Invalid IBKR date "${v.slice(0, 30)}"`);
  }
}

function parseFlexDateTime(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})[;, T](\d{2}):?(\d{2}):?(\d{2})?$/.exec(value.trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`;
}

const CASH_KIND: Array<[RegExp, InvestmentTransactionKind | 'deposit_withdrawal']> = [
  [/payment in lieu/i, 'payment_in_lieu'],
  [/withholding/i, 'withholding_tax'],
  [/dividend/i, 'dividend'],
  [/interest (received|accrued)|bond interest received/i, 'interest_received'],
  [/interest paid|bond interest paid/i, 'interest_paid'],
  [/deposits?\s*(\/|&|and)\s*withdrawals?/i, 'deposit_withdrawal'],
  [/fee|commission adjustment/i, 'fee'],
];

function cashKind(type: string, amount: string): InvestmentTransactionKind {
  const hit = CASH_KIND.find(([re]) => re.test(type));
  if (!hit) return 'other';
  if (hit[1] === 'deposit_withdrawal') return new D(amount).isNegative() ? 'withdrawal' : 'deposit';
  return hit[1];
}

type SectionName = 'AccountInformation' | 'OpenPositions' | 'Trades' | 'CashTransactions' | 'CorporateActions' | 'CashReport' | 'ConversionRates';

interface StatementInput {
  attrs: Attrs;
  sections: Map<SectionName, Attrs[]>;
}

function buildStatement(input: StatementInput, errors: RowError[], rowOffset: { n: number }): FlexStatementResult {
  const { attrs, sections } = input;
  const accountId = text(attrs, 'accountid');
  const mask = maskIdentifier(accountId);
  const externalAccountId = `ibkr:${mask ?? 'unknown'}`;
  const notes: string[] = [];
  const info = sections.get('AccountInformation')?.[0];
  const baseCurrency = (info && text(info, 'currency')) ?? null;
  const from = parseFlexDate(text(attrs, 'fromdate'));
  const to = parseFlexDate(text(attrs, 'todate'));
  const generatedAt = parseFlexDateTime(text(attrs, 'whengenerated'));

  const guard = <T>(label: string, rowNumber: number, fn: () => T): T | null => {
    try {
      return fn();
    } catch (e) {
      errors.push({ rowNumber, field: label, message: e instanceof FileParseError ? e.message : `${label} row could not be parsed` });
      return null;
    }
  };

  // Trades: prefer execution-level rows so orders and closed lots are not double counted.
  const tradeRows = sections.get('Trades') ?? [];
  const executions = tradeRows.filter((t) => (text(t, 'levelofdetail') ?? 'EXECUTION').toUpperCase() === 'EXECUTION');
  const orders = tradeRows.filter((t) => (text(t, 'levelofdetail') ?? '').toUpperCase() === 'ORDER');
  const usedTrades = executions.length ? executions : orders;
  if (tradeRows.length && usedTrades.length !== tradeRows.length) notes.push('Summary, order, or lot-level trade rows were ignored in favour of execution rows.');
  const investmentTransactions: NormalizedInvestmentTransaction[] = [];
  for (const t of usedTrades) {
    rowOffset.n += 1;
    const tx = guard('Trades', rowOffset.n, () => {
      const buySell = (text(t, 'buysell') ?? '').toUpperCase();
      const quantity = decimal(t, 'quantity');
      const tradeDate = parseFlexDate(text(t, 'tradedate') ?? text(t, 'datetime'));
      if (!tradeDate) throw new FileParseError('Trade has no trade date');
      const currency = text(t, 'currency');
      if (!currency) throw new FileParseError('Trade has no currency');
      const kind: InvestmentTransactionKind = buySell.startsWith('SELL') || (quantity !== null && new D(quantity).isNegative()) ? 'sell' : 'buy';
      return {
        externalId: `ibkr-trade:${text(t, 'tradeid') ?? text(t, 'transactionid') ?? `${tradeDate}:${rowOffset.n}`}`,
        externalAccountId,
        kind,
        tradeDate,
        settleDate: parseFlexDate(text(t, 'settledatetarget', 'settledate')),
        symbol: text(t, 'symbol'),
        instrumentId: text(t, 'conid'),
        isin: text(t, 'isin'),
        assetClass: text(t, 'assetcategory'),
        description: cleanText(text(t, 'description') ?? text(t, 'symbol') ?? 'Trade', 200),
        quantity,
        price: decimal(t, 'tradeprice'),
        grossAmount: decimal(t, 'proceeds', 'trademoney'),
        commission: decimal(t, 'ibcommission'),
        netAmount: decimal(t, 'netcash'),
        currency,
        raw: t,
      } satisfies NormalizedInvestmentTransaction;
    });
    if (tx) investmentTransactions.push(tx);
  }

  const cashRows = sections.get('CashTransactions') ?? [];
  const detail = cashRows.filter((c) => (text(c, 'levelofdetail') ?? 'DETAIL').toUpperCase() !== 'SUMMARY');
  const cashMovements: NormalizedInvestmentTransaction[] = [];
  for (const c of detail) {
    rowOffset.n += 1;
    const tx = guard('CashTransactions', rowOffset.n, () => {
      const amount = decimal(c, 'amount');
      if (amount === null) throw new FileParseError('Cash transaction has no amount');
      const type = text(c, 'type') ?? 'Other';
      const date = parseFlexDate(text(c, 'datetime', 'date', 'reportdate', 'settledate'));
      if (!date) throw new FileParseError('Cash transaction has no date');
      const currency = text(c, 'currency');
      if (!currency) throw new FileParseError('Cash transaction has no currency');
      return {
        externalId: `ibkr-cash:${text(c, 'transactionid') ?? `${date}:${type}:${amount}:${rowOffset.n}`}`,
        externalAccountId,
        kind: cashKind(type, amount),
        tradeDate: date,
        settleDate: parseFlexDate(text(c, 'settledate')),
        symbol: text(c, 'symbol'),
        instrumentId: text(c, 'conid'),
        isin: text(c, 'isin'),
        assetClass: text(c, 'assetcategory'),
        description: cleanText(text(c, 'description') ?? type, 200),
        quantity: null,
        price: null,
        grossAmount: amount,
        commission: null,
        netAmount: amount,
        currency,
        raw: c,
      } satisfies NormalizedInvestmentTransaction;
    });
    if (tx) cashMovements.push(tx);
  }

  let holdings: NormalizedHoldingsSnapshot | null = null;
  const positions = sections.get('OpenPositions');
  if (positions) {
    const summary = positions.filter((p) => (text(p, 'levelofdetail') ?? 'SUMMARY').toUpperCase() === 'SUMMARY');
    const lots = summary.length ? summary : positions;
    const byKey = new Map<string, NormalizedHoldingLine>();
    let asOf: string | null = null;
    for (const p of lots) {
      rowOffset.n += 1;
      const line = guard('OpenPositions', rowOffset.n, () => {
        const symbol = text(p, 'symbol') ?? text(p, 'conid');
        const currency = text(p, 'currency');
        if (!symbol || !currency) throw new FileParseError('Position has no symbol or currency');
        const reportDate = parseFlexDate(text(p, 'reportdate'));
        if (reportDate && (asOf === null || reportDate > asOf)) asOf = reportDate;
        return {
          symbol,
          name: cleanText(text(p, 'description'), 200) || null,
          instrumentId: text(p, 'conid'),
          isin: text(p, 'isin'),
          assetClass: text(p, 'assetcategory'),
          quantity: decimal(p, 'position', 'quantity'),
          price: decimal(p, 'markprice'),
          value: decimal(p, 'positionvalue'),
          costBasis: decimal(p, 'costbasismoney'),
          currency,
          fxRateToBase: decimal(p, 'fxratetobase'),
          priceKind: 'statement',
        } satisfies NormalizedHoldingLine;
      });
      if (!line) continue;
      const key = `${line.instrumentId ?? line.symbol}|${line.currency}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, line);
      } else {
        // Lot-level rows: aggregate quantities and values; the mark price stays per instrument.
        const addNullable = (a: string | null, b: string | null) => (a === null || b === null ? null : toDecimalString(new D(a).plus(b)));
        byKey.set(key, { ...existing, quantity: addNullable(existing.quantity, line.quantity), value: addNullable(existing.value, line.value), costBasis: addNullable(existing.costBasis, line.costBasis) });
      }
    }
    holdings = { externalAccountId, asOf: asOf ?? to, completeness: 'complete', source: IBKR_FLEX_SOURCE, lines: [...byKey.values()] };
  } else {
    notes.push('The Flex query has no Open Positions section, so no holdings snapshot was produced.');
  }

  const cashBalances: NormalizedCashBalance[] = [];
  for (const c of sections.get('CashReport') ?? []) {
    rowOffset.n += 1;
    const currency = text(c, 'currency');
    if (!currency || currency.toUpperCase() === 'BASE_SUMMARY') continue;
    const bal = guard('CashReport', rowOffset.n, () => decimal(c, 'endingcash'));
    if (bal === null) continue;
    cashBalances.push({ externalAccountId, currency, amount: bal, asOf: parseFlexDate(text(c, 'todate')) ?? to, source: IBKR_FLEX_SOURCE });
  }

  const fxRates: NormalizedFxRate[] = [];
  const seenFx = new Set<string>();
  for (const r of sections.get('ConversionRates') ?? []) {
    rowOffset.n += 1;
    const fx = guard('ConversionRates', rowOffset.n, () => {
      const base = text(r, 'fromcurrency');
      const quote = text(r, 'tocurrency');
      const rate = decimal(r, 'rate');
      const asOf = parseFlexDate(text(r, 'reportdate', 'date'));
      if (!base || !quote || rate === null || !asOf) throw new FileParseError('Conversion rate row is incomplete');
      if (!new D(rate).greaterThan(0)) return null;
      return { base, quote, rate, asOf, source: IBKR_FLEX_SOURCE } satisfies NormalizedFxRate;
    });
    if (fx && !seenFx.has(`${fx.base}/${fx.quote}/${fx.asOf}`)) {
      seenFx.add(`${fx.base}/${fx.quote}/${fx.asOf}`);
      fxRates.push(fx);
    }
  }
  if (fxRates.length === 0 && holdings && baseCurrency) {
    for (const line of holdings.lines) {
      if (!line.fxRateToBase || line.currency === baseCurrency || !holdings.asOf) continue;
      const key = `${line.currency}/${baseCurrency}/${holdings.asOf}`;
      if (seenFx.has(key) || !new D(line.fxRateToBase).greaterThan(0)) continue;
      seenFx.add(key);
      fxRates.push({ base: line.currency, quote: baseCurrency, rate: line.fxRateToBase, asOf: holdings.asOf, source: `${IBKR_FLEX_SOURCE} (fxRateToBase)` });
    }
  }

  const corporateActions: NormalizedCorporateAction[] = [];
  for (const c of sections.get('CorporateActions') ?? []) {
    rowOffset.n += 1;
    const action = guard('CorporateActions', rowOffset.n, () => ({
      externalId: `ibkr-ca:${text(c, 'transactionid') ?? text(c, 'actionid') ?? rowOffset.n}`,
      externalAccountId,
      type: text(c, 'type') ?? 'unknown',
      description: cleanText(text(c, 'actiondescription', 'description') ?? '', 300),
      symbol: text(c, 'symbol'),
      quantity: decimal(c, 'quantity'),
      reportDate: parseFlexDate(text(c, 'reportdate')),
      raw: c,
    }));
    if (action) corporateActions.push(action);
  }

  return {
    externalAccountId,
    accountMask: mask,
    baseCurrency,
    coverage: { from, to, note: from && to ? null : 'The Flex statement did not state its period.' },
    generatedAt,
    sectionsPresent: [...sections.keys()],
    investmentTransactions,
    cashMovements,
    holdings,
    cashBalances,
    fxRates,
    corporateActions,
    notes,
  };
}

const SECTION_ELEMENTS: Record<SectionName, string> = {
  AccountInformation: '',
  OpenPositions: 'OpenPosition',
  Trades: 'Trade',
  CashTransactions: 'CashTransaction',
  CorporateActions: 'CorporateAction',
  CashReport: 'CashReportCurrency',
  ConversionRates: 'ConversionRate',
};

const ARRAY_TAGS = new Set(['FlexStatement', ...Object.values(SECTION_ELEMENTS).filter(Boolean), 'Order', 'Lot', 'SymbolSummary', 'AssetSummary']);

/** Parses an Activity Flex Query XML document. Documents with DOCTYPE or ENTITY declarations are rejected first. */
export function parseFlexXml(xml: string): FlexParseResult {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new FileParseError('Flex XML with DOCTYPE or entity declarations is not accepted');
  if (!/<FlexQueryResponse\b/.test(xml)) throw new FileParseError('Not a Flex Query response');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    processEntities: false,
    htmlEntities: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    maxNestedTags: 32,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new FileParseError('The Flex XML is malformed');
  }
  const response = doc.FlexQueryResponse as Record<string, unknown> | undefined;
  const container = response?.FlexStatements as Record<string, unknown> | undefined;
  const list = (container?.FlexStatement as Array<Record<string, unknown>> | undefined) ?? [];
  if (list.length === 0) throw new FileParseError('The Flex response contains no statements');
  const errors: RowError[] = [];
  const rowOffset = { n: 0 };
  const statements = list.map((stmt) => {
    const sections = new Map<SectionName, Attrs[]>();
    for (const [section, element] of Object.entries(SECTION_ELEMENTS) as Array<[SectionName, string]>) {
      if (!(section in stmt)) continue;
      const node = stmt[section];
      if (section === 'AccountInformation') {
        sections.set(section, node && typeof node === 'object' ? [lowerKeys(node as Record<string, unknown>)] : []);
        continue;
      }
      const items = node && typeof node === 'object' ? ((node as Record<string, unknown>)[element] as Array<Record<string, unknown>> | undefined) ?? [] : [];
      sections.set(section, items.map(lowerKeys));
    }
    return buildStatement({ attrs: lowerKeys(stmt), sections }, errors, rowOffset);
  });
  return { format: 'xml', statements, errors, parserVersion: IBKR_FLEX_PARSER_VERSION };
}

function detectCsvSection(header: string[]): SectionName | null {
  const h = new Set(header.map((c) => c.toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (h.has('fromcurrency') && h.has('tocurrency') && h.has('rate')) return 'ConversionRates';
  if (h.has('endingcash')) return 'CashReport';
  if (h.has('actiondescription')) return 'CorporateActions';
  if (h.has('tradeid') || (h.has('buysell') && h.has('tradeprice'))) return 'Trades';
  if (h.has('markprice') && (h.has('position') || h.has('quantity'))) return 'OpenPositions';
  if (h.has('type') && h.has('amount') && (h.has('datetime') || h.has('transactionid'))) return 'CashTransactions';
  if ((h.has('clientaccountid') || h.has('accountid')) && (h.has('currencyprimary') || h.has('currency')) && (h.has('name') || h.has('accounttype') || h.has('customertype'))) return 'AccountInformation';
  return null;
}

/**
 * Parses the Flex CSV variant: several sections in one file, each introduced by its own header row (optionally
 * wrapped in BOF/BOA/BOS/HEADER/DATA/EOS/EOA/EOF records). Sections are identified by their header columns.
 */
export function parseFlexCsv(csv: string): FlexParseResult {
  const parsed = Papa.parse<string[]>(csv.replace(/^\uFEFF/, ''), { header: false, skipEmptyLines: true, worker: false, dynamicTyping: false });
  const errors: RowError[] = [];
  const byAccount = new Map<string, StatementInput>();
  let current: { section: SectionName | null; header: string[] } | null = null;
  const wrapper = new Set(['BOF', 'BOA', 'BOS', 'EOS', 'EOA', 'EOF']);
  let fileAttrs: Attrs = {};
  const ensure = (accountId: string) => {
    const existing = byAccount.get(accountId);
    if (existing) return existing;
    const created: StatementInput = { attrs: { ...fileAttrs, accountid: accountId }, sections: new Map() };
    byAccount.set(accountId, created);
    return created;
  };
  parsed.data.forEach((cells, index) => {
    const rowNumber = index + 1;
    const first = (cells[0] ?? '').trim().toUpperCase();
    if (wrapper.has(first)) {
      if (first === 'BOF') {
        // BOF,<account>,<query name>,<type>,<from>,<to>,<generated>,...
        fileAttrs = { accountid: cells[1] ?? '', fromdate: cells[4] ?? '', todate: cells[5] ?? '', whengenerated: cells[6] ?? '' };
      }
      if (first === 'BOS' || first === 'EOS') current = null;
      return;
    }
    let row = cells;
    let isHeader: boolean;
    if (first === 'HEADER' || first === 'DATA') {
      isHeader = first === 'HEADER';
      row = cells.slice(2);
    } else {
      isHeader = detectCsvSection(cells) !== null && cells.every((c) => !/^-?\d/.test(c.trim()) || c.trim() === '');
    }
    if (isHeader) {
      current = { section: detectCsvSection(row), header: row };
      return;
    }
    if (!current) {
      errors.push({ rowNumber, field: null, message: 'Data row outside a recognised section' });
      return;
    }
    if (current.section === null) return;
    const record: Attrs = {};
    current.header.forEach((h, i) => {
      record[h] = row[i] ?? '';
    });
    const normalized = normaliseCsvRecord(record);
    const accountId = normalized.accountid || fileAttrs.accountid || 'unknown';
    const statement = ensure(accountId);
    const list = statement.sections.get(current.section) ?? [];
    list.push(normalized);
    statement.sections.set(current.section, list);
    if (normalized.fromdate && !statement.attrs.fromdate) statement.attrs.fromdate = normalized.fromdate;
    if (normalized.todate && !statement.attrs.todate) statement.attrs.todate = normalized.todate;
  });
  if (byAccount.size === 0) throw new FileParseError('No recognised Flex sections were found in the CSV');
  const rowOffset = { n: 0 };
  const statements = [...byAccount.values()].map((s) => {
    if (!s.attrs.fromdate || !s.attrs.todate) {
      const dates = [...(s.sections.get('Trades') ?? []), ...(s.sections.get('CashTransactions') ?? [])]
        .map((r) => {
          try {
            return parseFlexDate(text(r, 'tradedate', 'datetime', 'reportdate'));
          } catch {
            return null;
          }
        })
        .filter((d): d is string => d !== null)
        .sort();
      s.attrs.fromdate ||= (dates[0] ?? '').replace(/-/g, '');
      s.attrs.todate ||= (dates[dates.length - 1] ?? '').replace(/-/g, '');
    }
    const result = buildStatement(s, errors, rowOffset);
    if (!fileAttrs.fromdate) {
      result.coverage.note = 'The CSV has no header record; coverage is inferred from the transaction dates.';
    }
    return result;
  });
  return { format: 'csv', statements, errors, parserVersion: IBKR_FLEX_PARSER_VERSION };
}
