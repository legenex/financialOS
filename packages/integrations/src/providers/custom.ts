import type { ProviderDescriptor } from '@financialos/contracts';
import { EMAIL_ALLOWED_CONTENT_TYPES } from '../adapters/email';
import {
  CHECKED_ON,
  IMPORT_CAPABILITIES,
  capabilities,
  no,
  numberField,
  readOnlyMethod,
  secretField,
  selectField,
  textField,
  unverifiedHistory,
  urlField,
  yes,
} from './support';

export const customHttpProvider: ProviderDescriptor = {
  key: 'custom_http',
  name: 'Custom HTTP source',
  category: 'api',
  regions: ['Global'],
  summary: 'A read-only JSON endpoint you describe declaratively: where the records are, which field is the date, the amount, the id. No scripting of any kind.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'The configuration is data, never code. Record and field locations are dotted paths resolved by a plain lookup, with no wildcards, filters, or expression language, and neither eval nor a scriptable JSONPath is used anywhere. The request is always a GET through the SSRF-guarded fetch, with the owner allowlist applied, a 4 MiB byte cap per page, at most 5,000 records per page, 100,000 records per run, and the page cap the configuration itself declares. Preview fetches a handful of records and reports exactly which ones mapped and which did not, so a mapping can be fixed before anything is committed.',
  methods: [
    readOnlyMethod({
      method: 'custom_http',
      label: 'Declarative HTTP source',
      description: 'Define the endpoint, its authentication header, its pagination style, and the field mapping. FinancialOS executes exactly that and nothing else.',
      fields: [
        urlField('baseUrl', 'Base URL', 'The origin and any common path prefix, for example https://api.example.com/v1.'),
        textField('path', 'Path', 'The path of the records endpoint, relative to the base URL.'),
        secretField('token', 'Credential', 'The token or key. Sent in the header you name below, and never in a URL.'),
        textField('authHeaderName', 'Auth header name', 'For example Authorization or X-Api-Key. Leave blank if the endpoint needs none.', false, '^[A-Za-z0-9-]{1,64}$'),
        selectField('authScheme', 'Auth scheme', 'bearer sends "Bearer <token>", raw sends the token as-is, none sends no credential.', [
          { value: 'bearer', label: 'Bearer' },
          { value: 'raw', label: 'Raw value' },
          { value: 'none', label: 'No credential' },
        ]),
        textField('recordsPath', 'Records path', 'Dotted path to the array of records, for example data.items. Leave blank if the response is itself an array.', false),
        textField('fieldMap.id', 'Id field', 'Dotted path to the unique id of a record.'),
        textField('fieldMap.date', 'Date field', 'Dotted path to the date. An ISO date or date-time is expected.'),
        textField('fieldMap.amount', 'Amount field', 'Dotted path to the signed amount. Money out must be negative.'),
        textField('fieldMap.description', 'Description field', 'Dotted path to the description.'),
        textField('fieldMap.currency', 'Currency field', 'Optional dotted path to a per-record currency code.', false),
        textField('fieldMap.status', 'Status field', 'Optional dotted path to a status. Values such as "pending" mark the row pending.', false),
        selectField('pagination.kind', 'Pagination', 'How the endpoint pages.', [
          { value: 'none', label: 'Single page' },
          { value: 'cursor', label: 'Cursor in the response' },
          { value: 'page', label: 'Page number' },
          { value: 'offset', label: 'Offset and limit' },
        ]),
        numberField('pagination.maxPages', 'Maximum pages', 'Hard stop for one run. At most 500.'),
      ],
      ownerActivationSteps: [
        'Get the endpoint URL and a read-only credential from the service.',
        'Add the host to the outbound allowlist in Settings. Nothing is fetched from a host you have not allowed.',
        'Fill in the base URL, path, credential, and header name here.',
        'Fetch one page by hand (or use Preview) and note the exact field names, then fill in the dotted paths.',
        'Press Preview. It shows the rows that mapped and, for anything that did not, exactly which field failed and what the record contained.',
        'When the preview looks right, save. Only then does the source become a sync.',
      ],
      capabilities: capabilities({
        transactions: yes('Whatever the mapped endpoint returns.'),
        pendingTransactions: yes('Only when a status field is mapped and its value reads as pending.'),
        balances: no('A custom source describes transactions. Map a balance endpoint separately if you need one.'),
      }),
      historyLimit: unverifiedHistory(null, 'Whatever the endpoint returns for the requested window.'),
      fileKinds: [],
      verificationLevel: 'implemented',
      documentationUrls: [],
      unsupportedProducts: [
        'Scripts, expressions, and templates are not supported anywhere in the configuration. A path is a dotted field name and nothing else.',
        'Non-GET requests cannot be configured.',
        'XML, CSV, and HTML responses are not mapped; the endpoint must return JSON.',
      ],
      scheduleSupported: true,
    }),
  ],
};

export const customMcpProvider: ProviderDescriptor = {
  key: 'custom_mcp',
  name: 'Custom MCP server',
  category: 'mcp',
  regions: ['Global'],
  summary: 'An owner-approved remote MCP server over HTTPS. Read-only tools only, output capped and treated as inert data.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Remote servers only. A configuration that names a command, arguments, an environment block, a working directory, or the stdio transport is rejected outright: FinancialOS does not launch a process for a connection. Plain http is refused unless the owner has allowlisted exactly that host and port. Tools are filtered before any call: a name carrying an action verb is always refused, a description carrying one is refused unless the server annotates the tool readOnlyHint: true, and a tool that is neither recognisably a read nor annotated is refused by default. Output is capped and stripped of control characters; it is reported as data and is never followed as an instruction.',
  methods: [
    readOnlyMethod({
      method: 'mcp_oauth',
      label: 'Remote MCP server',
      description: 'Connect to an MCP server you trust. Tool discovery shows exactly which tools were allowed and which were refused, with the reason.',
      fields: [
        urlField('url', 'Server URL', 'The https endpoint of the MCP server. A command or stdio configuration is rejected.'),
        textField('allowTools', 'Extra allowed tools', 'Optional comma-separated tool names you approve by name. A name containing an action verb is still refused.', false),
        textField('denyTools', 'Refused tools', 'Optional comma-separated tool names to refuse regardless of what the server says.', false),
        numberField('maxOutputBytes', 'Output cap (bytes)', 'Maximum bytes kept from one tool call. Default 262144.'),
      ],
      ownerActivationSteps: [
        'Get the server\'s https URL from whoever operates it, and satisfy yourself that you trust it with read access to whatever it exposes.',
        'Add its host to the outbound allowlist in Settings.',
        'Paste the URL here and press Connect. If the server is OAuth-protected, FinancialOS runs the discovery, registration, and PKCE flow.',
        'Press Test and read the tool list. Every refused tool is listed with the reason; approve any you want by name only if you are sure it only reads.',
      ],
      capabilities: capabilities({ agentContext: yes('Read-only tools only; output is inert, size-capped data.') }),
      historyLimit: unverifiedHistory(null, 'Whatever the server returns.'),
      fileKinds: [],
      verificationLevel: 'implemented',
      documentationUrls: ['https://modelcontextprotocol.io/specification'],
      unsupportedProducts: [
        'Local process (stdio) servers: a configuration naming a command, args, env, cwd, or stdio is rejected.',
        'Write tools of any kind.',
        'MCP results are never written to the ledger.',
      ],
      scheduleSupported: false,
    }),
  ],
};

export const emailImapProvider: ProviderDescriptor = {
  key: 'email_imap',
  name: 'Mailbox attachments (IMAP)',
  category: 'email',
  regions: ['Global'],
  summary: 'Reads statement attachments from a mailbox you own. Read-only selection, BODY.PEEK, sender allowlist, and per-attachment deduplication.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Implemented with imapflow 2.0.5 (MIT, published 2026-09-15, pure JavaScript with no native bindings, so it installs on arm64 like any other package). The mailbox is opened with readOnly: true, which imapflow documents as issuing IMAP EXAMINE rather than SELECT, and the connection is refused if the server does not grant it. Attachments are fetched through download(), which uses BODY.PEEK, so no message is marked as read. This module contains no call that could flag, move, expunge, delete, append, or send: the only IMAP commands used are connect, examine, search, fetch, download, and logout. The IMAP host is resolved and checked against the same destination policy the HTTP client uses, because IMAP is not HTTP and cannot go through safeFetch. Attachments are identified by message-id plus the sha256 of the attachment itself, so re-reading a mailbox never re-imports a file.',
  methods: [
    readOnlyMethod({
      method: 'imap',
      label: 'IMAP mailbox (read-only)',
      description: 'Poll a mailbox for statement attachments from senders you list. Nothing is ever marked, moved, deleted, or sent.',
      fields: [
        textField('host', 'IMAP host', 'The server hostname, for example imap.example.com.'),
        numberField('port', 'Port', 'IMAPS port. Default 993. Plain IMAP and STARTTLS are not offered.'),
        textField('username', 'Username', 'The mailbox login.'),
        secretField('password', 'Password or app password', 'Use an app-specific password where the provider offers one, and give it mail-read access only.'),
        textField('mailbox', 'Mailbox', 'Which folder to read. Default INBOX. A dedicated folder you file statements into is safer.', false),
        textField('senderAllowlist', 'Allowed senders', 'Comma-separated addresses. Only messages from these addresses are read; there is no wildcard.'),
        numberField('sinceDays', 'Look back (days)', 'How far back to search on each run. Default 90.'),
        numberField('maxAttachmentBytes', 'Attachment size limit (bytes)', 'Attachments larger than this are skipped and reported.'),
      ],
      ownerActivationSteps: [
        'In your mail provider, create an app-specific password (or a dedicated read-only mail account) rather than using your main password.',
        'Create a folder and set up a rule that files statement emails into it, so this connection never needs to look at your whole inbox.',
        'Enter the host, port 993, the username, and the app password here.',
        'List the exact sender addresses that send you statements. There is no wildcard: anything not listed is skipped and reported as skipped.',
        'Add the IMAP host to the outbound allowlist in Settings if it is not a public address.',
        'Press Test. It confirms the mailbox opened read-only; if the server refuses a read-only selection, FinancialOS stops rather than continuing.',
      ],
      capabilities: capabilities({
        statements: yes(`Attachments of the accepted types (${EMAIL_ALLOWED_CONTENT_TYPES.slice(0, 4).join(', ')}, and the other documented statement types) are handed to the import pipeline.`),
        transactions: yes('Indirectly: each attachment goes through the same parser and preview as a manual upload, and nothing is committed without the owner confirming.'),
      }),
      historyLimit: unverifiedHistory(null, 'The look-back window you set, bounded by what the mailbox still holds.'),
      fileKinds: ['csv', 'xlsx', 'ofx', 'qfx', 'pdf'],
      verificationLevel: 'implemented',
      documentationUrls: ['https://imapflow.com/docs/api/imapflow-client', 'https://www.npmjs.com/package/imapflow'],
      unsupportedProducts: [
        'Sending, replying, forwarding: there is no code path for any of them.',
        'Flagging, moving, deleting, expunging, or changing mailbox settings: none of those commands is issued.',
        'Plain IMAP and STARTTLS on port 143: only IMAPS is accepted, so a downgrade can never happen silently.',
        'Message bodies are not read or stored; only attachment parts of accepted types are downloaded.',
      ],
      scheduleSupported: true,
    }),
  ],
};

export const documentUploadProvider: ProviderDescriptor = {
  key: 'document_upload',
  name: 'Document upload',
  category: 'document',
  regions: ['Global'],
  summary: 'Upload a statement or export from any institution. CSV, Excel, OFX/QFX, IBKR Flex, and text PDFs are parsed; the file is kept as evidence.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Every file is checked before it is parsed: size, extension, declared type, executable signatures, text encoding, HTML and script content, DOCTYPE and entity declarations, PDF encryption and active content, and, for workbooks, the ZIP structure (entry count, paths, encryption, declared and actual sizes, compression ratio, macros, ActiveX, OLE objects, external links). A file that fails any check is refused with the exact reason. Parsers never execute anything from a file, and document text is data, never instructions. Duplicate identical rows are preserved and flagged by the duplicate check rather than silently dropped. PDF statements are parsed from the text layer only; a scanned, image-only PDF is refused with a clear message, because no OCR is installed.',
  methods: [
    readOnlyMethod({
      method: 'file_import',
      label: 'File upload',
      description: 'Upload a file, confirm the column mapping once, preview every row, then commit. A committed batch can be reversed.',
      fields: [],
      ownerActivationSteps: [
        'Download the statement or export from your institution in CSV, Excel, OFX/QFX, or PDF.',
        'Upload it here and choose the account and legal entity it belongs to.',
        'Confirm the detected column mapping, or correct it. Saving it as a template means the next file from the same export needs no mapping.',
        'Review the preview: new rows, duplicates, possible duplicates, and errors are listed with their row numbers.',
        'Commit. If something was wrong, reverse the batch; the ledger records the reversal rather than deleting anything.',
      ],
      capabilities: IMPORT_CAPABILITIES,
      historyLimit: unverifiedHistory(null, 'Whatever period the uploaded file covers.'),
      fileKinds: ['csv', 'xlsx', 'ofx', 'qfx', 'ibkr_flex_xml', 'ibkr_flex_csv', 'pdf'],
      verificationLevel: 'implemented',
      documentationUrls: [],
      unsupportedProducts: [
        'Scanned or image-only PDFs: no OCR is installed, so they are refused with an explanation rather than parsed badly.',
        'Macro-enabled workbooks (.xlsm, .xlsb), encrypted workbooks, and legacy .xls: refused, with the reason and an alternative.',
        'Archives, images, and executables are refused.',
      ],
      scheduleSupported: false,
    }),
  ],
};

export const manualHoldingsProvider: ProviderDescriptor = {
  key: 'manual_holdings',
  name: 'Manual holdings and agreements',
  category: 'document',
  regions: ['Global'],
  summary:
    'Positions, valuations, restrictions, and terms the owner enters from documents, for assets with no API: private notes, restricted equity, fixed-income agreements, property.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Nothing here is fetched, inferred, or estimated. Every value is owner-entered and carries its own provenance: which document it came from, the date it was stated, and whether it has been verified. Unverified restriction terms block a sale schedule rather than producing an optimistic one, an indicative value is labelled indicative and never presented as proceeds, and a missing figure stays missing instead of becoming zero. No price, date, rate, or return is ever invented to fill a gap.',
  methods: [
    readOnlyMethod({
      method: 'manual_entry',
      label: 'Owner-entered positions and terms',
      description: 'Record a holding, a valuation, a restriction, or a set of terms, each linked to the document it came from.',
      fields: [],
      ownerActivationSteps: [
        'Upload the statement, agreement, or certificate to Documents first, so the figure has evidence behind it.',
        'Create the account and set its legal entity, economic owner, and liquidity class.',
        'Enter the position or valuation, with the date the document states and a link to that document.',
        'Record restriction terms separately, and mark them verified only once you have read them in the agreement. Unverified terms deliberately block sale-schedule calculations.',
        'Update the valuation when a new statement arrives. The history is kept; a new figure never overwrites the old one.',
      ],
      capabilities: capabilities({
        holdings: yes('Owner-entered positions with their own provenance and completeness.'),
        balances: yes('Owner-reported totals, recorded as such and never mistaken for a provider balance.'),
        statements: yes('Each figure links to the document it came from.'),
      }),
      historyLimit: unverifiedHistory(null, 'As far back as the owner enters.'),
      fileKinds: ['pdf', 'csv', 'xlsx'],
      verificationLevel: 'implemented',
      documentationUrls: [],
      unsupportedProducts: [
        'There is no API behind these assets. Nothing is fetched and nothing is refreshed automatically.',
        'Valuations are as of the date on the document, not today.',
      ],
      scheduleSupported: false,
    }),
  ],
};
