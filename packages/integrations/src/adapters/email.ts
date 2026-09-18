import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { ImapFlow } from 'imapflow';
import { z } from 'zod';
import { classifyAddress, ipLiteral } from '@financialos/security/net';
import type { AdapterContext } from '../core/context';
import { CredentialMissingError, InvalidConfigError, ProviderUnavailableError, ReadOnlyViolationError } from '../core/errors';
import { ImportLimits } from '@financialos/contracts';
import { inertText } from './http';
import type { ConnectionTestResult, ProviderAdapter } from './types';

/**
 * Optional read-only IMAP attachment ingestion.
 *
 * The mailbox is opened with EXAMINE (imapflow's `readOnly: true`), message bodies are fetched with
 * BODY.PEEK so the \Seen flag is never set, and this module contains no call that could flag, move, expunge,
 * delete, append, or send anything: the only imapflow methods used are `connect`, `mailboxOpen` (read-only),
 * `search`, `fetch`, `download`, and `logout`.
 *
 * Dependency note (checked 2026-09-18): imapflow 2.0.5, MIT, published 2026-09-15, pure JavaScript with no
 * native bindings (no gypfile/binary/os/cpu fields and no .node artefacts in the tarball), so it installs on
 * arm64 like any other package. https://imapflow.com/docs/api/imapflow-client documents `readOnly` as "Open
 * in read-only mode (uses IMAP EXAMINE instead of SELECT)".
 */

export const EMAIL_LIMITS = {
  maxAttachmentBytes: ImportLimits.maxFileBytes,
  maxAttachmentsPerMessage: 10,
  maxMessagesPerRun: 200,
  connectTimeoutMs: 20_000,
  greetingTimeoutMs: 20_000,
  socketTimeoutMs: 60_000,
} as const;

/** Attachment content types the ingestion accepts. Anything else is skipped and reported. */
export const EMAIL_ALLOWED_CONTENT_TYPES = [
  'text/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/x-ofx',
  'application/ofx',
  'application/vnd.intu.qfx',
  'application/xml',
  'text/xml',
  'application/pdf',
  'application/octet-stream',
] as const;

export const EmailSourceConfig = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535).default(993),
    /** IMAPS only. STARTTLS on port 143 is not offered, because a downgrade must never be silent. */
    secure: z.literal(true).default(true),
    mailbox: z.string().min(1).max(200).default('INBOX'),
    /** Only messages from these addresses are read. An empty list means nothing is ingested. */
    senderAllowlist: z.array(z.string().email().max(320)).min(1).max(50),
    /** Only look this many days back. */
    sinceDays: z.number().int().min(1).max(3650).default(90),
    maxAttachmentBytes: z.number().int().min(1024).max(EMAIL_LIMITS.maxAttachmentBytes).default(EMAIL_LIMITS.maxAttachmentBytes),
    allowedContentTypes: z.array(z.string().max(120)).max(30).default([...EMAIL_ALLOWED_CONTENT_TYPES]),
  })
  .strict();
export type EmailSourceConfig = z.infer<typeof EmailSourceConfig>;

export interface EmailAttachment {
  /** Stable identity: message-id plus the attachment's own sha256. */
  dedupeKey: string;
  messageId: string;
  from: string;
  subject: string;
  receivedAt: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  bytes: Uint8Array;
}

export interface EmailIngestResult {
  attachments: EmailAttachment[];
  /** Messages seen but skipped, with the reason. */
  skipped: Array<{ messageId: string; reason: string }>;
  messagesExamined: number;
  mailboxReadOnly: boolean;
}

export function parseEmailConfig(raw: unknown): EmailSourceConfig {
  const parsed = EmailSourceConfig.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new InvalidConfigError(`The mailbox configuration is not valid${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
  }
  return parsed.data;
}

/**
 * Resolves the IMAP host and refuses a private, loopback, link-local, or otherwise non-public address unless
 * the owner has allowlisted exactly that host and port. IMAP is not HTTP, so safeFetch cannot guard it; this
 * applies the same destination policy by hand before a socket is opened.
 */
export async function assertPublicImapHost(ctx: AdapterContext, host: string, port: number): Promise<void> {
  const lower = host.trim().toLowerCase();
  const allowlisted = ctx.allowlist.some((entry) => entry.host.toLowerCase() === lower && entry.port === port);
  if (allowlisted) return;
  const literal = ipLiteral(lower);
  const addresses = literal !== null ? [literal] : (await dnsLookup(lower, { all: true, verbatim: true }).catch(() => [])).map((r) => r.address);
  if (addresses.length === 0) throw new InvalidConfigError(`The mail host "${lower}" could not be resolved.`);
  for (const address of addresses) {
    const verdict = classifyAddress(address);
    if (verdict.neverAllowed || !verdict.public) {
      throw new InvalidConfigError(`The mail host "${lower}" resolves to a ${verdict.reason ?? 'non-public'} address. Add it to the outbound allowlist if that is intended.`);
    }
  }
}

function normaliseAddress(value: unknown): string {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (value && typeof value === 'object') {
    const node = value as { address?: unknown; value?: unknown };
    if (typeof node.address === 'string') return node.address.trim().toLowerCase();
    if (Array.isArray(node.value) && node.value[0] && typeof node.value[0] === 'object') {
      const first = node.value[0] as { address?: unknown };
      if (typeof first.address === 'string') return first.address.trim().toLowerCase();
    }
  }
  return '';
}

interface BodyPart {
  part: string;
  type: string;
  fileName: string;
  size: number;
}

/** Walks a BODYSTRUCTURE and returns the parts that look like file attachments. */
export function collectAttachmentParts(node: unknown, path: string[] = []): BodyPart[] {
  if (!node || typeof node !== 'object') return [];
  const record = node as {
    part?: unknown;
    type?: unknown;
    disposition?: unknown;
    dispositionParameters?: unknown;
    parameters?: unknown;
    size?: unknown;
    childNodes?: unknown;
  };
  const out: BodyPart[] = [];
  const children = Array.isArray(record.childNodes) ? record.childNodes : [];
  for (const [index, child] of children.entries()) out.push(...collectAttachmentParts(child, [...path, String(index + 1)]));
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  const disposition = typeof record.disposition === 'string' ? record.disposition.toLowerCase() : '';
  const dispositionParams = (record.dispositionParameters ?? {}) as Record<string, unknown>;
  const params = (record.parameters ?? {}) as Record<string, unknown>;
  const fileName = typeof dispositionParams.filename === 'string' ? dispositionParams.filename : typeof params.name === 'string' ? params.name : '';
  const part = typeof record.part === 'string' && record.part !== '' ? record.part : path.join('.');
  if (part && (disposition === 'attachment' || (fileName !== '' && type !== 'multipart/alternative')) && !type.startsWith('multipart/')) {
    out.push({ part, type, fileName: inertText(fileName, 200) || 'attachment', size: typeof record.size === 'number' ? record.size : 0 });
  }
  return out;
}

async function readStream(stream: NodeJS.ReadableStream, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > limit) throw new InvalidConfigError(`An attachment exceeds the ${limit}-byte limit.`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Reads new attachments from the configured mailbox. It selects the mailbox read-only, never changes a flag,
 * and returns every attachment with a dedupe key so the worker can ignore ones it has already imported.
 */
export async function ingestMailboxAttachments(ctx: AdapterContext, options: { knownKeys?: ReadonlySet<string> } = {}): Promise<EmailIngestResult> {
  const config = parseEmailConfig(ctx.config.mailbox ?? ctx.config);
  const user = ctx.credentials.username ?? '';
  const pass = ctx.credentials.password ?? '';
  if (!user) throw new CredentialMissingError('username');
  if (!pass) throw new CredentialMissingError('password');
  if (config.secure !== true) throw new ReadOnlyViolationError('a plaintext IMAP connection was requested; only IMAPS is allowed');
  await assertPublicImapHost(ctx, config.host, config.port);

  const allowlist = new Set(config.senderAllowlist.map((a) => a.trim().toLowerCase()));
  const allowedTypes = new Set(config.allowedContentTypes.map((t) => t.toLowerCase()));
  const known = options.knownKeys ?? new Set<string>();
  const since = new Date(ctx.clock.now().getTime() - config.sinceDays * 86_400_000);

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user, pass },
    logger: false,
    connectionTimeout: EMAIL_LIMITS.connectTimeoutMs,
    greetingTimeout: EMAIL_LIMITS.greetingTimeoutMs,
    socketTimeout: EMAIL_LIMITS.socketTimeoutMs,
    clientInfo: { name: 'FinancialOS', version: '0.1.0' },
  });

  const attachments: EmailAttachment[] = [];
  const skipped: EmailIngestResult['skipped'] = [];
  let messagesExamined = 0;
  try {
    await client.connect();
  } catch (err) {
    throw new ProviderUnavailableError(`The mail server at ${config.host}:${config.port} could not be reached or refused the credentials`, err);
  }
  try {
    // readOnly: true issues EXAMINE, so nothing in the mailbox changes state by being looked at.
    const mailbox = await client.mailboxOpen(config.mailbox, { readOnly: true });
    // A server that will not give EXAMINE is refused: looking must never change the mailbox.
    if (mailbox.readOnly !== true) throw new ReadOnlyViolationError('the server did not grant a read-only mailbox selection');
    const uids = (await client.search({ since }, { uid: true })) || [];
    const list = Array.isArray(uids) ? uids.slice(-EMAIL_LIMITS.maxMessagesPerRun) : [];
    for (const uid of list) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
      messagesExamined += 1;
      const message = await client.fetchOne(String(uid), { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
      if (!message || typeof message !== 'object') continue;
      const envelope = (message as { envelope?: Record<string, unknown> }).envelope ?? {};
      const from = normaliseAddress(Array.isArray(envelope.from) ? envelope.from[0] : envelope.from);
      const messageId = inertText((envelope as { messageId?: unknown }).messageId, 300) || `uid:${uid}`;
      if (!allowlist.has(from)) {
        skipped.push({ messageId, reason: `sender ${from || '(unknown)'} is not on the allowlist` });
        continue;
      }
      const parts = collectAttachmentParts((message as { bodyStructure?: unknown }).bodyStructure).slice(0, EMAIL_LIMITS.maxAttachmentsPerMessage);
      if (parts.length === 0) {
        skipped.push({ messageId, reason: 'no attachment' });
        continue;
      }
      const internalDate = (message as { internalDate?: Date }).internalDate;
      const receivedAt = internalDate instanceof Date ? internalDate.toISOString() : ctx.clock.now().toISOString();
      const subject = inertText((envelope as { subject?: unknown }).subject, 300);
      for (const part of parts) {
        if (!allowedTypes.has(part.type)) {
          skipped.push({ messageId, reason: `attachment type ${part.type || 'unknown'} is not accepted` });
          continue;
        }
        if (part.size > config.maxAttachmentBytes) {
          skipped.push({ messageId, reason: `attachment is ${part.size} bytes, over the ${config.maxAttachmentBytes}-byte limit` });
          continue;
        }
        // download() fetches with BODY.PEEK, so the message is not marked \Seen.
        const downloaded = await client.download(String(uid), part.part, { uid: true });
        if (!downloaded?.content) {
          skipped.push({ messageId, reason: 'the attachment could not be downloaded' });
          continue;
        }
        const bytes = await readStream(downloaded.content, config.maxAttachmentBytes);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const dedupeKey = `${messageId}|${sha256}`;
        if (known.has(dedupeKey)) {
          skipped.push({ messageId, reason: 'already imported' });
          continue;
        }
        attachments.push({
          dedupeKey,
          messageId,
          from,
          subject,
          receivedAt,
          fileName: part.fileName,
          contentType: part.type,
          sizeBytes: bytes.byteLength,
          sha256,
          bytes,
        });
      }
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return { attachments, skipped, messagesExamined, mailboxReadOnly: true };
}

export const emailImapAdapter: ProviderAdapter = {
  key: 'email_imap',
  method: 'imap',
  readOnly: true,

  async test(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const config = parseEmailConfig(ctx.config.mailbox ?? ctx.config);
    const user = ctx.credentials.username ?? '';
    const pass = ctx.credentials.password ?? '';
    if (!user) throw new CredentialMissingError('username');
    if (!pass) throw new CredentialMissingError('password');
    await assertPublicImapHost(ctx, config.host, config.port);
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: true,
      auth: { user, pass },
      logger: false,
      connectionTimeout: EMAIL_LIMITS.connectTimeoutMs,
      greetingTimeout: EMAIL_LIMITS.greetingTimeoutMs,
      socketTimeout: EMAIL_LIMITS.socketTimeoutMs,
      clientInfo: { name: 'FinancialOS', version: '0.1.0' },
    });
    try {
      await client.connect();
    } catch (err) {
      throw new ProviderUnavailableError(`The mail server at ${config.host}:${config.port} could not be reached or refused the credentials`, err);
    }
    try {
      const mailbox = await client.mailboxOpen(config.mailbox, { readOnly: true });
      return {
        ok: mailbox.readOnly === true,
        detail:
          mailbox.readOnly === true
            ? `Opened ${config.mailbox} read-only; it holds ${mailbox.exists} message(s).`
            : `The server did not grant a read-only selection of ${config.mailbox}. FinancialOS will not proceed without it.`,
        grantedScopes: [],
        identity: user,
        observations: [
          'The mailbox is opened with EXAMINE and attachments are fetched with BODY.PEEK, so no message is marked as read.',
          `Sender allowlist: ${config.senderAllowlist.length} address(es).`,
          'This connection can only read. It has no path to flag, move, delete, or send a message.',
        ],
      };
    } finally {
      await client.logout().catch(() => undefined);
    }
  },
};
