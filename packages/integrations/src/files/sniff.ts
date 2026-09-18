import { ImportLimits, type FileCheck, type ImportFileKind } from '@financialos/contracts';
import { inspectOoxmlZip, type ZipInspection } from './zip';

export interface SniffInput {
  bytes: Uint8Array;
  fileName: string;
  declaredMime: string | null;
}

export interface SniffResult {
  ok: boolean;
  kind: ImportFileKind | null;
  checks: FileCheck[];
  /** Decoded text for text formats (BOM removed), otherwise null. */
  text: string | null;
  zip: ZipInspection | null;
}

const EXTENSION_KINDS: Record<string, ImportFileKind[]> = {
  csv: ['csv', 'ibkr_flex_csv'],
  txt: ['csv', 'ibkr_flex_csv', 'ofx', 'qfx'],
  tsv: ['csv'],
  xlsx: ['xlsx'],
  ofx: ['ofx'],
  qfx: ['qfx', 'ofx'],
  xml: ['ibkr_flex_xml', 'ofx'],
  pdf: ['pdf'],
};

const MIME_KINDS: Record<string, ImportFileKind[] | 'any'> = {
  'application/octet-stream': 'any',
  'text/csv': ['csv', 'ibkr_flex_csv'],
  'text/plain': ['csv', 'ibkr_flex_csv', 'ofx', 'qfx'],
  'application/vnd.ms-excel': ['csv', 'ibkr_flex_csv'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/x-ofx': ['ofx', 'qfx'],
  'application/ofx': ['ofx', 'qfx'],
  'application/vnd.intu.qfx': ['qfx', 'ofx'],
  'application/xml': ['ibkr_flex_xml', 'ofx'],
  'text/xml': ['ibkr_flex_xml', 'ofx'],
  'application/pdf': ['pdf'],
};

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function executableKind(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x4d, 0x5a])) return 'Windows executable (MZ)';
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return 'ELF executable';
  if (startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf]) || startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe])) return 'Mach-O executable';
  if (startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe])) return 'Java class or universal binary';
  if (startsWith(bytes, [0x23, 0x21])) return 'script with an interpreter line';
  if (startsWith(bytes, [0x00, 0x61, 0x73, 0x6d])) return 'WebAssembly module';
  return null;
}

interface DecodedText {
  text: string | null;
  problem: string | null;
}

function decodeText(bytes: Uint8Array): DecodedText {
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) {
    const le = bytes[0] === 0xff;
    try {
      const text = new TextDecoder(le ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(bytes.subarray(2));
      if (text.includes('\0')) return { text: null, problem: 'Text contains null characters' };
      return { text, problem: null };
    } catch {
      return { text: null, problem: 'Invalid UTF-16 text' };
    }
  }
  const body = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? bytes.subarray(3) : bytes;
  if (body.includes(0)) return { text: null, problem: 'Text contains null bytes (binary content)' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), problem: null };
  } catch {
    // Many bank exports are Windows-1252. Decode as such, but only when it is plausibly text.
    const text = new TextDecoder('windows-1252').decode(body);
    // eslint-disable-next-line no-control-regex
    const controls = (text.match(/[\u0000-\u0008\u000E-\u001F\u007F]/g) ?? []).length;
    if (controls > text.length / 100) return { text: null, problem: 'Content is not text' };
    return { text, problem: null };
  }
}

const HTML_OR_SCRIPT = /<\s*(script|html|iframe|object|embed|svg|body|meta\s+http-equiv)\b|<!doctype\s+html|javascript:/i;

function looksLikeDelimited(text: string): boolean {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '').slice(0, 30);
  if (lines.length === 0) return false;
  for (const delim of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => l.split(delim).length - 1);
    const withDelim = counts.filter((c) => c > 0).length;
    if (withDelim >= Math.max(1, Math.ceil(lines.length * 0.6))) return true;
  }
  return false;
}

function isFlexCsv(text: string): boolean {
  const head = text.slice(0, 4096);
  const firstLine = head.split(/\r\n|\n|\r/, 1)[0] ?? '';
  return /^"?BOF"?[,|\t]/.test(firstLine) || /(^|[",|\t])ClientAccountID("|[,|\t]|$)/.test(firstLine);
}

/**
 * Identifies an uploaded file from its content, cross-checked against the extension and declared MIME type.
 * Every check is reported (passed or failed) so the owner sees exactly why a file was accepted or rejected.
 */
export function sniffFile(input: SniffInput): SniffResult {
  const { bytes, fileName, declaredMime } = input;
  const checks: FileCheck[] = [];
  const add = (check: string, passed: boolean, detail: string) => checks.push({ check, passed, detail });
  const fail = (): SniffResult => ({ ok: false, kind: null, checks, text: null, zip: null });

  if (bytes.length === 0) {
    add('size', false, 'The file is empty');
    return fail();
  }
  if (bytes.length > ImportLimits.maxFileBytes) {
    add('size', false, `The file is ${bytes.length} bytes; the limit is ${ImportLimits.maxFileBytes}`);
    return fail();
  }
  add('size', true, `${bytes.length} bytes (limit ${ImportLimits.maxFileBytes})`);

  const ext = extensionOf(fileName);
  if (!EXTENSION_KINDS[ext]) {
    add('extension', false, `Extension ".${ext}" is not accepted (csv, tsv, txt, xlsx, ofx, qfx, xml, pdf)`);
    return fail();
  }
  add('extension', true, `.${ext}`);

  const mime = declaredMime?.split(';')[0]?.trim().toLowerCase() || null;
  if (mime !== null && !(ImportLimits.allowedMime as readonly string[]).includes(mime)) {
    add('mime', false, `Declared type ${mime} is not accepted`);
    return fail();
  }
  add('mime', true, mime ?? 'not declared');

  const exe = executableKind(bytes);
  if (exe) {
    add('executable', false, `The file is a ${exe}`);
    return fail();
  }
  add('executable', true, 'No executable signature');

  let kind: ImportFileKind;
  let text: string | null = null;
  let zip: ZipInspection | null = null;

  const pdfOffset = findPdfHeader(bytes);
  if (pdfOffset >= 0) {
    kind = 'pdf';
    add('magic', true, 'PDF document (%PDF-)');
    const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
    if (!tail.includes('%%EOF')) {
      add('pdf_structure', false, 'The PDF is truncated (no %%EOF marker)');
      return fail();
    }
    const body = new TextDecoder('latin1').decode(bytes);
    if (/\/Encrypt\b/.test(body)) {
      add('pdf_encryption', false, 'The PDF is password-protected or encrypted. Download an unprotected statement or use CSV/OFX.');
      return fail();
    }
    if (/\/(JavaScript|Launch|RichMedia|XFA)\b|\/JS\s*[(<]/.test(body)) {
      add('pdf_active_content', false, 'The PDF contains scripts, launch actions, or interactive forms, which are not accepted');
      return fail();
    }
    add('pdf_structure', true, 'PDF header and trailer present; no encryption or active content');
  } else if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    zip = inspectOoxmlZip(bytes);
    checks.push(...zip.checks);
    if (!zip.ok) return { ...fail(), zip };
    kind = 'xlsx';
    add('magic', true, 'Excel workbook (OOXML)');
  } else if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    add('magic', false, 'This is an encrypted Office file or a legacy .xls workbook. Save it as an unprotected .xlsx or export as CSV.');
    return fail();
  } else if (startsWith(bytes, [0x1f, 0x8b]) || startsWith(bytes, [0x42, 0x5a, 0x68]) || startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf]) || startsWith(bytes, [0x52, 0x61, 0x72, 0x21])) {
    add('magic', false, 'Compressed archives are not accepted');
    return fail();
  } else if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || startsWith(bytes, [0xff, 0xd8, 0xff]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    add('magic', false, 'Images are not accepted. Export the statement as CSV, OFX, or a text PDF.');
    return fail();
  } else {
    const decoded = decodeText(bytes);
    if (decoded.problem || decoded.text === null) {
      add('text_encoding', false, decoded.problem ?? 'Content is not text');
      return fail();
    }
    text = decoded.text.replace(/^\uFEFF/, '');
    add('text_encoding', true, 'Readable text');
    const head = text.slice(0, 8192);
    const trimmedHead = head.trimStart();
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
      add('xml_doctype', false, 'Document type or entity declarations are not accepted');
      return fail();
    }
    if (/^OFXHEADER\s*:/i.test(trimmedHead)) {
      kind = ext === 'qfx' ? 'qfx' : 'ofx';
      add('magic', true, 'OFX 1.x (SGML header)');
    } else if (/<\?OFX\b/i.test(head) || /<OFX>/i.test(head)) {
      kind = ext === 'qfx' ? 'qfx' : 'ofx';
      add('magic', true, 'OFX 2.x (XML)');
    } else if (/<FlexQueryResponse\b/.test(head)) {
      kind = 'ibkr_flex_xml';
      add('magic', true, 'Interactive Brokers Flex Query XML');
    } else if (HTML_OR_SCRIPT.test(text.slice(0, 65536))) {
      add('markup', false, 'The file contains HTML or script content');
      return fail();
    } else if (trimmedHead.startsWith('<')) {
      add('magic', false, 'Unrecognised XML or markup document');
      return fail();
    } else if (isFlexCsv(text)) {
      kind = 'ibkr_flex_csv';
      add('magic', true, 'Interactive Brokers Flex Query CSV');
    } else if (looksLikeDelimited(text)) {
      kind = 'csv';
      add('magic', true, 'Delimited text (CSV)');
    } else {
      add('magic', false, 'The text is not a recognised statement format (CSV, OFX, or Flex)');
      return fail();
    }
    if (kind !== 'ibkr_flex_xml' && kind !== 'ofx' && kind !== 'qfx' && HTML_OR_SCRIPT.test(text.slice(0, 65536))) {
      add('markup', false, 'The file contains HTML or script content');
      return fail();
    }
    add('markup', true, 'No HTML or script content');
  }

  const allowedForExt = EXTENSION_KINDS[ext] ?? [];
  if (!allowedForExt.includes(kind)) {
    add('extension_match', false, `Content is ${kind} but the extension is .${ext}`);
    return fail();
  }
  add('extension_match', true, `Content matches .${ext}`);
  if (mime) {
    const allowed = MIME_KINDS[mime];
    if (allowed !== 'any' && !(allowed ?? []).includes(kind)) {
      add('mime_match', false, `Content is ${kind} but the declared type is ${mime}`);
      return fail();
    }
    add('mime_match', true, `Declared type ${mime} is consistent`);
  }
  return { ok: true, kind, checks, text, zip };
}

function findPdfHeader(bytes: Uint8Array): number {
  // The PDF header may be preceded by a little junk; the spec allows it within the first 1024 bytes.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  const idx = head.indexOf('%PDF-');
  // Only whitespace and NUL padding may precede the header; matching NUL is the point of this class.
  // eslint-disable-next-line no-control-regex
  return idx >= 0 && /^[\s\u0000]*$/.test(head.slice(0, idx)) ? idx : -1;
}
