import { Inflate } from 'fflate';
import type { FileCheck } from '@financialos/contracts';

/**
 * Defensive ZIP inspection for OOXML workbooks. The central directory is read directly and every entry is
 * decompressed with a streaming inflater that counts real output bytes, so a lying size header cannot cause an
 * unbounded allocation.
 */

export const ZIP_LIMITS = {
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxEntries: 2000,
  maxCompressionRatio: 100,
  /** Ratio checks only apply above this size: tiny parts naturally compress very well. */
  ratioCheckMinBytes: 1024 * 1024,
  maxRetainedPartBytes: 20 * 1024 * 1024,
};

export interface ZipEntryInfo {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  declaredSize: number;
  actualSize: number;
}

export interface ZipInspection {
  checks: FileCheck[];
  ok: boolean;
  entries: ZipEntryInfo[];
  /** Decompressed XML/relationship parts (bounded), keyed by entry name. */
  parts: Map<string, string>;
}

const MACRO_CONTENT_TYPES = [
  'application/vnd.ms-excel.sheet.macroenabled',
  'application/vnd.ms-office.vbaproject',
  'application/vnd.ms-excel.template.macroenabled',
  'application/vnd.ms-excel.addin.macroenabled',
  'application/vnd.ms-excel.sheet.binary.macroenabled',
  'application/vnd.ms-office.activex',
  'application/vnd.openxmlformats-officedocument.oleobject',
  'application/vnd.ms-excel.intl-macrosheet',
  'application/vnd.ms-excel.macrosheet',
  'application/vnd.ms-office.vbaprojectsignature',
];

const DANGEROUS_PART = [
  { re: /(^|\/)vbaProject(Signature)?\.bin$/i, what: 'a VBA macro project' },
  { re: /^xl\/macrosheets\//i, what: 'Excel 4.0 macro sheets' },
  { re: /^xl\/activeX\//i, what: 'ActiveX controls' },
  { re: /^xl\/embeddings\//i, what: 'embedded OLE objects' },
  { re: /^xl\/externalLinks\//i, what: 'external workbook links' },
  { re: /^xl\/connections\.xml$/i, what: 'external data connections' },
  { re: /^customUI\//i, what: 'custom UI extensions' },
  { re: /\.(exe|dll|js|vbs|ps1|bat|cmd|scr|jar|com|msi|hta)$/i, what: 'an executable attachment' },
];

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

class ZipLimitError extends Error {}

interface CdEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  declaredSize: number;
  localOffset: number;
}

function readCentralDirectory(bytes: Uint8Array): CdEntry[] {
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipLimitError('ZIP end-of-central-directory record not found');
  const total = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) throw new ZipLimitError('ZIP64 archives are not accepted');
  if (total > ZIP_LIMITS.maxEntries) throw new ZipLimitError(`ZIP has ${total} entries (limit ${ZIP_LIMITS.maxEntries})`);
  if (cdOffset + cdSize > bytes.length) throw new ZipLimitError('ZIP central directory is out of bounds');
  const entries: CdEntry[] = [];
  let p = cdOffset;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (let i = 0; i < total; i += 1) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) throw new ZipLimitError('ZIP central directory is corrupt');
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const compressedSize = u32(bytes, p + 20);
    const declaredSize = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, flags, compressedSize, declaredSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryData(bytes: Uint8Array, entry: CdEntry): Uint8Array {
  const o = entry.localOffset;
  if (o + 30 > bytes.length || u32(bytes, o) !== 0x04034b50) throw new ZipLimitError(`ZIP local header for an entry is corrupt`);
  const start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new ZipLimitError('ZIP entry data is out of bounds');
  return bytes.subarray(start, end);
}

/** Streams one entry through the inflater, enforcing the remaining byte budget. */
function inflateBounded(data: Uint8Array, method: number, budget: number, keep: boolean, onText?: (chunk: Uint8Array) => void): { size: number; content: Uint8Array | null } {
  const kept: Uint8Array[] = [];
  let size = 0;
  const handle = (chunk: Uint8Array) => {
    size += chunk.byteLength;
    if (size > budget) throw new ZipLimitError(`Decompressed content exceeds ${ZIP_LIMITS.maxUncompressedBytes} bytes`);
    if (keep) kept.push(chunk.slice());
    onText?.(chunk);
  };
  if (method === 0) {
    handle(data);
  } else if (method === 8) {
    const inflater = new Inflate((chunk) => handle(chunk));
    const step = 64 * 1024;
    for (let i = 0; i < data.length; i += step) inflater.push(data.subarray(i, Math.min(i + step, data.length)), i + step >= data.length);
    if (data.length === 0) inflater.push(new Uint8Array(0), true);
  } else {
    throw new ZipLimitError(`Unsupported ZIP compression method ${method}`);
  }
  if (!keep) return { size, content: null };
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of kept) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { size, content: out };
}

export function inspectOoxmlZip(bytes: Uint8Array): ZipInspection {
  const checks: FileCheck[] = [];
  const parts = new Map<string, string>();
  const infos: ZipEntryInfo[] = [];
  const add = (check: string, passed: boolean, detail: string) => checks.push({ check, passed, detail });
  let entries: CdEntry[];
  try {
    entries = readCentralDirectory(bytes);
  } catch (e) {
    add('zip_structure', false, (e as Error).message);
    return { checks, ok: false, entries: infos, parts };
  }
  add('zip_entry_count', true, `${entries.length} entries (limit ${ZIP_LIMITS.maxEntries})`);
  const names = new Set<string>();
  for (const e of entries) {
    if (e.name.includes('..') || e.name.startsWith('/') || e.name.includes('\\') || e.name.includes('\0')) {
      add('zip_paths', false, 'ZIP contains an unsafe entry path');
      return { checks, ok: false, entries: infos, parts };
    }
    if (names.has(e.name)) {
      add('zip_paths', false, 'ZIP contains duplicate entry names');
      return { checks, ok: false, entries: infos, parts };
    }
    names.add(e.name);
  }
  add('zip_paths', true, 'Entry paths are relative and unique');
  if (entries.some((e) => (e.flags & 0x1) !== 0)) {
    add('zip_encryption', false, 'The workbook is encrypted. Remove the password or export as CSV.');
    return { checks, ok: false, entries: infos, parts };
  }
  add('zip_encryption', true, 'No encrypted entries');
  const declaredTotal = entries.reduce((acc, e) => acc + e.declaredSize, 0);
  if (declaredTotal > ZIP_LIMITS.maxUncompressedBytes) {
    add('zip_uncompressed_size', false, `Declared uncompressed size ${declaredTotal} bytes exceeds ${ZIP_LIMITS.maxUncompressedBytes}`);
    return { checks, ok: false, entries: infos, parts };
  }
  const dangerous = entries.map((e) => DANGEROUS_PART.find((d) => d.re.test(e.name))).find(Boolean);
  if (dangerous) {
    add('macro_content', false, `The workbook contains ${dangerous.what}. Save it as a plain .xlsx without macros or export as CSV.`);
    return { checks, ok: false, entries: infos, parts };
  }

  let total = 0;
  let doctype = false;
  try {
    for (const e of entries) {
      if (e.name.endsWith('/')) continue;
      const data = entryData(bytes, e);
      const isXml = /\.(xml|rels|vml)$/i.test(e.name) || e.name === '[Content_Types].xml';
      const keep = isXml && e.declaredSize <= ZIP_LIMITS.maxRetainedPartBytes;
      let tail = '';
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const scan = isXml
        ? (chunk: Uint8Array) => {
            const text = tail + decoder.decode(chunk, { stream: true });
            if (/<!DOCTYPE|<!ENTITY/i.test(text)) doctype = true;
            tail = text.slice(-16);
          }
        : undefined;
      const { size, content } = inflateBounded(data, e.method, ZIP_LIMITS.maxUncompressedBytes - total, keep, scan);
      total += size;
      if (size > ZIP_LIMITS.ratioCheckMinBytes && size / Math.max(1, e.compressedSize) > ZIP_LIMITS.maxCompressionRatio) {
        throw new ZipLimitError(`An entry expands more than ${ZIP_LIMITS.maxCompressionRatio}x (possible zip bomb)`);
      }
      if (size !== e.declaredSize) throw new ZipLimitError('An entry size does not match its header');
      infos.push({ name: e.name, method: e.method, flags: e.flags, compressedSize: e.compressedSize, declaredSize: e.declaredSize, actualSize: size });
      if (content) parts.set(e.name, new TextDecoder('utf-8', { fatal: false }).decode(content));
    }
  } catch (err) {
    const message = err instanceof ZipLimitError ? err.message : 'ZIP content could not be decompressed';
    add('zip_uncompressed_size', false, message);
    return { checks, ok: false, entries: infos, parts };
  }
  if (total > ZIP_LIMITS.ratioCheckMinBytes && total / Math.max(1, bytes.length) > ZIP_LIMITS.maxCompressionRatio) {
    add('zip_compression_ratio', false, `Archive expands more than ${ZIP_LIMITS.maxCompressionRatio}x (possible zip bomb)`);
    return { checks, ok: false, entries: infos, parts };
  }
  add('zip_uncompressed_size', true, `${total} bytes uncompressed (limit ${ZIP_LIMITS.maxUncompressedBytes})`);
  add('zip_compression_ratio', true, `Compression ratio within ${ZIP_LIMITS.maxCompressionRatio}x`);
  if (doctype) {
    add('xml_doctype', false, 'Workbook XML declares a DOCTYPE or entities, which is not accepted');
    return { checks, ok: false, entries: infos, parts };
  }
  add('xml_doctype', true, 'No DOCTYPE or entity declarations');

  const contentTypes = parts.get('[Content_Types].xml');
  if (!contentTypes || !names.has('xl/workbook.xml')) {
    add('ooxml_structure', false, 'Not an Excel workbook: [Content_Types].xml or xl/workbook.xml is missing');
    return { checks, ok: false, entries: infos, parts };
  }
  const lowerTypes = contentTypes.toLowerCase();
  const macroType = MACRO_CONTENT_TYPES.find((t) => lowerTypes.includes(t));
  if (macroType) {
    add('macro_content', false, 'The workbook declares macro or embedded-object content types (.xlsm/.xlsb). Save as plain .xlsx or export as CSV.');
    return { checks, ok: false, entries: infos, parts };
  }
  if (!lowerTypes.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')) {
    add('ooxml_structure', false, 'The package is not a standard .xlsx workbook');
    return { checks, ok: false, entries: infos, parts };
  }
  const rels = [...parts.entries()].filter(([n]) => n.endsWith('.rels')).map(([, v]) => v);
  if (rels.some((r) => /TargetMode\s*=\s*["']External["']/i.test(r) && /relationships\/(externalLink|oleObject|attachedTemplate|frame|subDocument)/i.test(r))) {
    add('macro_content', false, 'The workbook references external links or objects. Remove them or export as CSV.');
    return { checks, ok: false, entries: infos, parts };
  }
  add('ooxml_structure', true, 'Standard .xlsx workbook structure');
  add('macro_content', true, 'No macros, ActiveX, OLE objects, or external links');
  return { checks, ok: true, entries: infos, parts };
}
