import { D, isValidTimeZone, makeDate, toDecimalString, toLocalDate } from '@financialos/domain';
import { FileParseError } from '../core/errors';
import type { NormalizedHoldingLine, NormalizedInvestmentTransaction } from '../core/records';
import { maskIdentifier } from '../core/redact';
import { cleanText, type NormalizedRow, type RowError } from './normalize';

export const OFX_PARSER_VERSION = '1.0.0';

/**
 * Tolerant OFX reader for 1.x (SGML, unclosed leaf elements) and 2.x (XML). It uses its own tokenizer: no DTD,
 * no external or custom entities, only the five predefined XML entities and numeric character references.
 */

export const OFX_LIMITS = { maxElements: 500_000, maxDepth: 64, maxValueChars: 4096 };

export interface OfxNode {
  name: string;
  value: string | null;
  children: OfxNode[];
}

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z]{2,6});/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    if (body.startsWith('#')) {
      const cp = Number(body.slice(1));
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return PREDEFINED[body.toLowerCase()] ?? match;
  });
}

/** OFX aggregates (elements that contain other elements). Anything else is a leaf in SGML mode. */
const AGGREGATES = new Set(
  (
    'OFX SIGNONMSGSRSV1 SONRS STATUS FI BANKMSGSRSV1 STMTTRNRS STMTRS BANKACCTFROM BANKACCTTO CCACCTFROM CCACCTTO ' +
    'BANKTRANLIST BANKTRANLISTP STMTTRN STMTTRNP PAYEE LEDGERBAL AVAILBAL BALLIST BAL CURRENCY ORIGCURRENCY ' +
    'CREDITCARDMSGSRSV1 CCSTMTTRNRS CCSTMTRS INVSTMTMSGSRSV1 INVSTMTTRNRS INVSTMTRS INVACCTFROM INVACCTTO INVTRANLIST ' +
    'INVBANKTRAN BUYSTOCK SELLSTOCK BUYMF SELLMF BUYDEBT SELLDEBT BUYOPT SELLOPT BUYOTHER SELLOTHER INVBUY INVSELL ' +
    'INVTRAN SECID INCOME REINVEST INVEXPENSE TRANSFER MARGININTEREST RETOFCAP SPLIT JRNLFUND JRNLSEC CLOSUREOPT ' +
    'INVPOSLIST POSSTOCK POSMF POSDEBT POSOPT POSOTHER INVPOS INVBAL INVOOLIST SECLISTMSGSRSV1 SECLIST STOCKINFO ' +
    'MFINFO DEBTINFO OPTINFO OTHERINFO SECINFO MFASSETCLASS PORTION FIMFASSETCLASS FIPORTION INV401K INV401KBAL ' +
    'SIGNUPMSGSRSV1 ACCTINFORS ACCTINFO BANKACCTINFO CCACCTINFO INVACCTINFO EXTBANKDESC IMAGEDATA'
  ).split(' '),
);

/** Parses the OFX body into a tree. Leaf elements may be unclosed (SGML) or closed (XML). */
export function tokenizeOfx(text: string, sgml = true): OfxNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new FileParseError('OFX documents with DOCTYPE or entity declarations are not accepted');
  const start = text.search(/<OFX>/i);
  if (start < 0) throw new FileParseError('No <OFX> element found');
  const root: OfxNode = { name: '#root', value: null, children: [] };
  const stack: OfxNode[] = [root];
  let i = start;
  let count = 0;
  let pendingLeaf: OfxNode | null = null;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    const between = text.slice(i, lt);
    if (pendingLeaf && between.trim() !== '') {
      pendingLeaf.value = decodeEntities(between.trim()).slice(0, OFX_LIMITS.maxValueChars);
    } else if (!pendingLeaf && between.trim() !== '') {
      // Stray text inside an aggregate is ignored (tolerant).
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const cdata = text.slice(lt + 9, end < 0 ? text.length : end);
      if (pendingLeaf && cdata.trim()) pendingLeaf.value = cdata.trim().slice(0, OFX_LIMITS.maxValueChars);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    const gt = text.indexOf('>', lt + 1);
    if (gt < 0) throw new FileParseError('Unterminated tag in OFX document');
    const rawTag = text.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (rawTag.startsWith('!')) continue;
    if (rawTag.startsWith('/')) {
      const name = rawTag.slice(1).trim().toUpperCase();
      pendingLeaf = null;
      const idx = findOpen(stack, name);
      if (idx > 0) stack.length = idx;
      continue;
    }
    const selfClosing = rawTag.endsWith('/');
    const name = (selfClosing ? rawTag.slice(0, -1) : rawTag).split(/\s/)[0]!.toUpperCase();
    if (!/^[A-Z0-9_.]{1,64}$/.test(name)) throw new FileParseError('Invalid element name in OFX document');
    // A new tag while a leaf has a value (or, in SGML, an empty non-aggregate) closes that leaf.
    if (pendingLeaf && (pendingLeaf.value !== null || (sgml && !AGGREGATES.has(pendingLeaf.name)))) {
      const idx = stack.lastIndexOf(pendingLeaf);
      if (idx > 0) stack.length = idx;
    }
    pendingLeaf = null;
    count += 1;
    if (count > OFX_LIMITS.maxElements) throw new FileParseError('OFX document has too many elements');
    const node: OfxNode = { name, value: null, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (selfClosing) continue;
    if (stack.length >= OFX_LIMITS.maxDepth) throw new FileParseError('OFX document is nested too deeply');
    stack.push(node);
    pendingLeaf = node;
  }
  const ofx = root.children.find((c) => c.name === 'OFX');
  if (!ofx) throw new FileParseError('No <OFX> element found');
  return ofx;
}

function findOpen(stack: OfxNode[], name: string): number {
  for (let k = stack.length - 1; k > 0; k -= 1) if (stack[k]!.name === name) return k;
  return -1;
}

export function child(node: OfxNode | undefined, name: string): OfxNode | undefined {
  return node?.children.find((c) => c.name === name);
}
export function childrenNamed(node: OfxNode | undefined, name: string): OfxNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}
function val(node: OfxNode | undefined, ...path: string[]): string | null {
  let current = node;
  for (const p of path) current = child(current, p);
  const v = current?.value?.trim();
  return v ? v : null;
}
function findAll(node: OfxNode, name: string, out: OfxNode[] = []): OfxNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

export interface OfxDate {
  date: string;
  /** UTC instant when a time was present. */
  instant: string | null;
}

/**
 * Parses an OFX date such as `20260131`, `20260131120000.000`, or `20260131120000.000[-5:EST]` and returns the
 * calendar date in `timezone`. Date-only values are taken literally. Times without an explicit offset follow the
 * OFX default of GMT.
 */
export function parseOfxDate(value: string, timezone: string): OfxDate {
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(?:(\d{2})(?:\.(\d{1,3}))?)?)?\s*(?:\[\s*([+-]?\d{1,2})(?:[.:](\d{1,2}))?(?::([A-Za-z]{1,8}))?\s*\])?$/.exec(value.trim());
  if (!m) throw new FileParseError(`Invalid OFX date "${value.slice(0, 40)}"`);
  const [, y, mo, d, hh, mi, ss, , offH, offFrac] = m;
  let date: string;
  try {
    date = makeDate(Number(y), Number(mo), Number(d));
  } catch {
    throw new FileParseError(`Invalid OFX date "${value.slice(0, 40)}"`);
  }
  if (hh === undefined) return { date, instant: null };
  const hours = Number(offH ?? '0');
  let minutes = 0;
  if (offFrac !== undefined) {
    // "+5.30" is conventionally 5h30m; a single digit is a decimal fraction ("+5.5").
    minutes = offFrac.length === 1 ? Math.round(Number(`0.${offFrac}`) * 60) : Number(offFrac) < 60 ? Number(offFrac) : 0;
  }
  const totalMinutes = Math.abs(hours) * 60 + minutes;
  if (totalMinutes > 14 * 60) throw new FileParseError(`Invalid OFX time zone offset in "${value.slice(0, 40)}"`);
  const sign = (offH ?? '+').startsWith('-') ? -1 : 1;
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi ?? '0'), Number(ss ?? '0')) - sign * totalMinutes * 60_000;
  const instant = new Date(utcMs);
  if (Number(hh) > 23 || Number(mi ?? 0) > 59 || Number(ss ?? 0) > 60) throw new FileParseError(`Invalid OFX time in "${value.slice(0, 40)}"`);
  if (!isValidTimeZone(timezone)) throw new FileParseError('Unknown time zone');
  return { date: toLocalDate(instant, timezone), instant: instant.toISOString() };
}

function ofxAmount(value: string | null): string | null {
  if (value === null) return null;
  let text = value.trim().replace(/^\+/, '');
  if (/^-?\d+,\d+$/.test(text)) text = text.replace(',', '.');
  if (/^-?\.\d+$/.test(text)) text = text.replace('.', '0.');
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new FileParseError(`Invalid OFX amount "${value.slice(0, 40)}"`);
  return toDecimalString(new D(text));
}

export interface OfxBalance {
  amount: string;
  asOf: OfxDate | null;
}

export interface OfxStatement {
  kind: 'bank' | 'creditcard' | 'investment';
  accountMask: string | null;
  bankId: string | null;
  accountType: string | null;
  currency: string;
  period: { from: string | null; to: string | null };
  ledgerBalance: OfxBalance | null;
  availableBalance: OfxBalance | null;
  rows: NormalizedRow[];
  investmentTransactions: NormalizedInvestmentTransaction[];
  holdings: { asOf: string | null; lines: NormalizedHoldingLine[] } | null;
  investmentCash: string | null;
}

export interface OfxParseResult {
  version: 1 | 2;
  statements: OfxStatement[];
  errors: RowError[];
  parserVersion: string;
}

export interface OfxParseOptions {
  timezone: string;
  /** Used when a statement omits CURDEF. */
  defaultCurrency?: string;
}

function balanceOf(node: OfxNode | undefined, timezone: string): OfxBalance | null {
  if (!node) return null;
  const amount = ofxAmount(val(node, 'BALAMT'));
  if (amount === null) return null;
  const asOfRaw = val(node, 'DTASOF');
  return { amount, asOf: asOfRaw ? parseOfxDate(asOfRaw, timezone) : null };
}

function stmtRows(list: OfxNode | undefined, currency: string, timezone: string, errors: RowError[], counter: { n: number }, pending: boolean): NormalizedRow[] {
  const rows: NormalizedRow[] = [];
  const trns = list ? list.children.filter((c) => c.name === 'STMTTRN' || c.name === 'STMTTRNP') : [];
  for (const trn of trns) {
    counter.n += 1;
    const rowNumber = counter.n;
    try {
      const raw: Record<string, string> = {};
      for (const c of trn.children) if (c.value !== null) raw[c.name] = c.value;
      const payee = child(trn, 'PAYEE');
      const name = val(trn, 'NAME') ?? val(payee, 'NAME') ?? val(trn, 'EXTDNAME');
      const memo = val(trn, 'MEMO');
      const posted = val(trn, 'DTPOSTED') ?? val(trn, 'DTTRAN');
      const amountRaw = val(trn, 'TRNAMT');
      if (!posted) throw new FileParseError('Transaction has no DTPOSTED');
      const amount = ofxAmount(amountRaw);
      if (amount === null) throw new FileParseError('Transaction has no TRNAMT');
      const postedDate = parseOfxDate(posted, timezone);
      const userDate = val(trn, 'DTUSER');
      const trnCurrency = val(trn, 'CURRENCY', 'CURSYM') ?? val(trn, 'ORIGCURRENCY', 'CURSYM');
      const correctAction = val(trn, 'CORRECTACTION');
      if (correctAction) raw.CORRECTACTION = correctAction;
      rows.push({
        rowNumber,
        bookedOn: postedDate.date,
        valueOn: userDate ? parseOfxDate(userDate, timezone).date : null,
        description: cleanText([name, memo].filter((v, i, arr) => v && arr.indexOf(v) === i).join(' | ')) || cleanText(val(trn, 'TRNTYPE')) || '(no description)',
        counterparty: cleanText(name, 200) || null,
        reference: cleanText(val(trn, 'CHECKNUM') ?? val(trn, 'REFNUM'), 200) || null,
        amount,
        currency: trnCurrency && /^[A-Z]{3}$/.test(trnCurrency) && !val(trn, 'ORIGCURRENCY', 'CURSYM') ? trnCurrency : currency,
        balance: null,
        pending: pending || trn.name === 'STMTTRNP',
        externalId: val(trn, 'FITID'),
        categoryHint: val(trn, 'TRNTYPE'),
        raw,
      });
    } catch (e) {
      errors.push({ rowNumber, field: null, message: e instanceof FileParseError ? e.message : 'Transaction could not be parsed' });
    }
  }
  return rows;
}

const INVEST_KINDS: Record<string, NormalizedInvestmentTransaction['kind']> = {
  BUYSTOCK: 'buy',
  BUYMF: 'buy',
  BUYDEBT: 'buy',
  BUYOPT: 'buy',
  BUYOTHER: 'buy',
  REINVEST: 'buy',
  SELLSTOCK: 'sell',
  SELLMF: 'sell',
  SELLDEBT: 'sell',
  SELLOPT: 'sell',
  SELLOTHER: 'sell',
  INCOME: 'dividend',
  INVEXPENSE: 'fee',
  TRANSFER: 'other',
  MARGININTEREST: 'interest_paid',
  RETOFCAP: 'other',
  SPLIT: 'corporate_action',
};

function investmentTransactions(list: OfxNode | undefined, accountMask: string, currency: string, securities: Map<string, { ticker: string | null; name: string | null }>, timezone: string, errors: RowError[], counter: { n: number }): { tx: NormalizedInvestmentTransaction[]; bankRows: NormalizedRow[] } {
  const tx: NormalizedInvestmentTransaction[] = [];
  const bankRows: NormalizedRow[] = [];
  if (!list) return { tx, bankRows };
  for (const item of list.children) {
    if (item.name === 'DTSTART' || item.name === 'DTEND') continue;
    counter.n += 1;
    const rowNumber = counter.n;
    try {
      if (item.name === 'INVBANKTRAN') {
        const trn = child(item, 'STMTTRN');
        const rows = stmtRows({ name: 'LIST', value: null, children: trn ? [trn] : [] }, currency, timezone, errors, { n: rowNumber - 1 }, false);
        bankRows.push(...rows);
        continue;
      }
      const kind = INVEST_KINDS[item.name];
      if (!kind) {
        errors.push({ rowNumber, field: item.name, message: `Unsupported investment transaction type ${item.name}` });
        continue;
      }
      const inner = child(item, 'INVBUY') ?? child(item, 'INVSELL') ?? item;
      const invtran = child(inner, 'INVTRAN') ?? child(item, 'INVTRAN');
      const secId = val(inner, 'SECID', 'UNIQUEID') ?? val(item, 'SECID', 'UNIQUEID');
      const security = secId ? securities.get(secId) : undefined;
      const tradeRaw = val(invtran, 'DTTRADE');
      if (!tradeRaw) throw new FileParseError('Investment transaction has no DTTRADE');
      const units = ofxAmount(val(inner, 'UNITS'));
      const total = ofxAmount(val(inner, 'TOTAL') ?? val(item, 'TOTAL'));
      const incomeType = val(item, 'INCOMETYPE');
      const raw: Record<string, unknown> = { type: item.name };
      for (const c of [...item.children, ...(inner !== item ? inner.children : [])]) if (c.value !== null) raw[c.name] = c.value;
      tx.push({
        externalId: val(invtran, 'FITID') ?? `ofx-${rowNumber}`,
        externalAccountId: accountMask,
        kind: kind === 'dividend' && incomeType && /INTEREST/i.test(incomeType) ? 'interest_received' : kind,
        tradeDate: parseOfxDate(tradeRaw, timezone).date,
        settleDate: val(invtran, 'DTSETTLE') ? parseOfxDate(val(invtran, 'DTSETTLE')!, timezone).date : null,
        symbol: security?.ticker ?? null,
        instrumentId: secId,
        isin: val(inner, 'SECID', 'UNIQUEIDTYPE') === 'ISIN' ? secId : null,
        assetClass: item.name.replace(/^(BUY|SELL)/, '') || null,
        description: cleanText(val(invtran, 'MEMO') ?? security?.name ?? item.name),
        quantity: units,
        price: ofxAmount(val(inner, 'UNITPRICE')),
        grossAmount: total,
        commission: ofxAmount(val(inner, 'COMMISSION')),
        netAmount: total,
        currency: val(inner, 'CURRENCY', 'CURSYM') ?? currency,
        raw,
      });
    } catch (e) {
      errors.push({ rowNumber, field: item.name, message: e instanceof FileParseError ? e.message : 'Investment transaction could not be parsed' });
    }
  }
  return { tx, bankRows };
}

/** Parses an OFX/QFX document (1.x SGML or 2.x XML). */
export function parseOfx(text: string, options: OfxParseOptions): OfxParseResult {
  const version: 1 | 2 = /<\?OFX\b/i.test(text.slice(0, 4096)) || /^\s*<\?xml/i.test(text) ? 2 : 1;
  const root = tokenizeOfx(text, version === 1);
  const errors: RowError[] = [];
  const statements: OfxStatement[] = [];
  const counter = { n: 0 };
  const tz = options.timezone;

  const securities = new Map<string, { ticker: string | null; name: string | null }>();
  for (const info of findAll(root, 'SECINFO')) {
    const id = val(info, 'SECID', 'UNIQUEID');
    if (id) securities.set(id, { ticker: val(info, 'TICKER'), name: cleanText(val(info, 'SECNAME'), 200) || null });
  }

  for (const stmt of [...findAll(root, 'STMTRS'), ...findAll(root, 'CCSTMTRS')]) {
    const isCard = stmt.name === 'CCSTMTRS';
    const acct = child(stmt, isCard ? 'CCACCTFROM' : 'BANKACCTFROM');
    const currency = val(stmt, 'CURDEF') ?? options.defaultCurrency ?? null;
    if (!currency) throw new FileParseError('The statement has no currency (CURDEF)');
    const list = child(stmt, 'BANKTRANLIST');
    const pendingList = child(stmt, 'BANKTRANLISTP');
    const dtStart = val(list, 'DTSTART');
    const dtEnd = val(list, 'DTEND');
    statements.push({
      kind: isCard ? 'creditcard' : 'bank',
      accountMask: maskIdentifier(val(acct, 'ACCTID')),
      bankId: val(acct, 'BANKID'),
      accountType: isCard ? 'CREDITCARD' : val(acct, 'ACCTTYPE'),
      currency,
      period: { from: dtStart ? parseOfxDate(dtStart, tz).date : null, to: dtEnd ? parseOfxDate(dtEnd, tz).date : null },
      ledgerBalance: balanceOf(child(stmt, 'LEDGERBAL'), tz),
      availableBalance: balanceOf(child(stmt, 'AVAILBAL'), tz),
      rows: [...stmtRows(list, currency, tz, errors, counter, false), ...stmtRows(pendingList, currency, tz, errors, counter, true)],
      investmentTransactions: [],
      holdings: null,
      investmentCash: null,
    });
  }

  for (const stmt of findAll(root, 'INVSTMTRS')) {
    const acct = child(stmt, 'INVACCTFROM');
    const mask = maskIdentifier(val(acct, 'ACCTID')) ?? 'unknown';
    const currency = val(stmt, 'CURDEF') ?? options.defaultCurrency ?? null;
    if (!currency) throw new FileParseError('The investment statement has no currency (CURDEF)');
    const list = child(stmt, 'INVTRANLIST');
    const { tx, bankRows } = investmentTransactions(list, mask, currency, securities, tz, errors, counter);
    const asOfRaw = val(stmt, 'DTASOF');
    const asOf = asOfRaw ? parseOfxDate(asOfRaw, tz).date : null;
    const posList = child(stmt, 'INVPOSLIST');
    const lines: NormalizedHoldingLine[] = [];
    for (const pos of posList?.children ?? []) {
      const inv = child(pos, 'INVPOS');
      const id = val(inv, 'SECID', 'UNIQUEID');
      if (!inv || !id) {
        errors.push({ rowNumber: 0, field: pos.name, message: 'Position without a security identifier' });
        continue;
      }
      const sec = securities.get(id);
      lines.push({
        symbol: sec?.ticker ?? id,
        name: sec?.name ?? null,
        instrumentId: id,
        isin: val(inv, 'SECID', 'UNIQUEIDTYPE') === 'ISIN' ? id : null,
        assetClass: pos.name.replace(/^POS/, ''),
        quantity: ofxAmount(val(inv, 'UNITS')),
        price: ofxAmount(val(inv, 'UNITPRICE')),
        value: ofxAmount(val(inv, 'MKTVAL')),
        costBasis: null,
        currency: val(inv, 'CURRENCY', 'CURSYM') ?? currency,
        fxRateToBase: val(inv, 'CURRENCY', 'CURRATE'),
        priceKind: 'statement',
      });
    }
    statements.push({
      kind: 'investment',
      accountMask: mask,
      bankId: val(acct, 'BROKERID'),
      accountType: 'INVESTMENT',
      currency,
      period: {
        from: val(list, 'DTSTART') ? parseOfxDate(val(list, 'DTSTART')!, tz).date : null,
        to: val(list, 'DTEND') ? parseOfxDate(val(list, 'DTEND')!, tz).date : null,
      },
      ledgerBalance: null,
      availableBalance: null,
      rows: bankRows,
      investmentTransactions: tx,
      holdings: posList ? { asOf, lines } : null,
      investmentCash: ofxAmount(val(stmt, 'INVBAL', 'AVAILCASH')),
    });
  }
  if (statements.length === 0) throw new FileParseError('The OFX file contains no bank, credit card, or investment statement');
  return { version, statements, errors, parserVersion: OFX_PARSER_VERSION };
}
