import type { ProviderDescriptor } from '@financialos/contracts';
import { MERCURY_BASE_URL } from '../adapters/mercury';
import {
  CHECKED_ON,
  IMPORT_CAPABILITIES,
  capabilities,
  no,
  readOnlyMethod,
  secretField,
  selectField,
  textField,
  unverifiedHistory,
  urlField,
  yes,
} from './support';

const DOCS = [
  'https://docs.mercury.com/reference/getaccounts',
  'https://docs.mercury.com/reference/listtransactions',
  'https://docs.mercury.com/reference/listaccounttransactions',
  'https://docs.mercury.com/reference/getaccountcards',
  'https://docs.mercury.com/docs/getting-started',
  'https://docs.mercury.com/docs/api-token-security-policies',
];

export const mercuryProvider: ProviderDescriptor = {
  key: 'mercury',
  name: 'Mercury',
  category: 'bank',
  regions: ['US'],
  summary:
    'US business banking. The documented REST API returns accounts, balances, transactions, and card metadata with a read-only token. One connection per business.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Verified against Mercury\'s own reference on 2026-09-18. Two transaction endpoints exist with different pagination: /transactions is cursor-based (page.nextPage) and /account/{id}/transactions is offset-based with a total. The Account schema documents no currency field, so the connection currency is applied and shown as an assumption. Mercury documents no rate-limit headers and no 401/429 semantics, so this adapter handles them defensively without claiming they are documented. Mercury does document that a token unused for 45 days is deleted and that Read Only tokens need no IP allowlist.',
  methods: [
    readOnlyMethod({
      method: 'api_token',
      label: 'Read-only API token',
      description: 'A Mercury API token with Read Only permission. FinancialOS issues GET requests only; no write endpoint is reachable from the adapter.',
      fields: [
        secretField('apiToken', 'API token', 'The token from Mercury Settings > API tokens. Choose the Read Only scope; Mercury documents that Read Only tokens do not require an IP allowlist.'),
        selectField('currency', 'Account currency', 'Mercury does not return a currency on the account object. Set the currency these accounts are held in.', [{ value: 'USD', label: 'US dollar (USD)' }], false),
        textField('timezone', 'Statement time zone', 'Time zone used to turn Mercury timestamps into booking dates. Default America/New_York.', false),
        urlField('baseUrl', 'API base URL', `Override only if Mercury changes its base URL. Default ${MERCURY_BASE_URL}.`, false),
      ],
      ownerActivationSteps: [
        'Sign in to Mercury as an admin of the business whose account you want to read.',
        'Open Settings, then the API tokens section (Settings > Banking > API tokens in the current dashboard).',
        'Create a new token and choose the Read Only scope. Do not choose Read and Write.',
        'Copy the token once; Mercury shows it a single time.',
        'Paste it into this connection and press Test. Repeat the whole process per business: one Mercury token covers one Mercury organisation.',
        'Use the token at least once every 45 days, or Mercury deletes it (it emails a warning 7 days before).',
      ],
      capabilities: capabilities({
        balances: yes('currentBalance and availableBalance per account. Mercury documents no as-of timestamp, so sourceAsOf stays unknown.'),
        transactions: yes('Signed amounts with createdAt and postedAt, counterparty, kind, and the documented status enum (pending, sent, cancelled, failed, reversed, blocked).'),
        pendingTransactions: yes('A transaction with status "pending" or no postedAt is recorded as pending and books on its created date.'),
        cards: yes('lastFourDigits, nameOnCard, network, type, status and physicalCardStatus from /account/{id}/cards. Full card numbers are never requested; the revealcardpan endpoint is deliberately unreachable.'),
        statements: no('The REST API exposes statements only through the MCP server tool getAccountStatements, not through a documented REST endpoint this adapter uses.'),
        agentContext: no('Use the separate Mercury MCP connection for agent context.'),
      }),
      historyLimit: unverifiedHistory(
        null,
        'Mercury documents no maximum history on /transactions; the account-scoped endpoint defaults to the last 30 days when no start is given. No live account has been connected, so no verified depth can be stated.',
      ),
      fileKinds: [],
      verificationLevel: 'implemented',
      documentationUrls: DOCS,
      unsupportedProducts: [
        'Payments, transfers, and recipient management (requestSendMoney, createTransaction, createInternalTransfer, createRecipient and the rest) are out of scope by design.',
        'Card controls (createCard, freezeCard, cancelCard, revealCardPan) are out of scope by design.',
        'Webhooks, invoices, and customers are not read.',
        'Mercury Treasury and credit balances are only visible through the MCP tools, not through the REST endpoints this adapter uses.',
      ],
      scheduleSupported: true,
    }),
    readOnlyMethod({
      method: 'file_import',
      label: 'Statement import',
      description: 'Upload a CSV or PDF statement downloaded from the Mercury dashboard. Works immediately and does not need a token.',
      fields: [],
      ownerActivationSteps: [
        'In Mercury, open the account and use its statement or transaction export.',
        'Download the file and upload it here.',
        'Confirm the column mapping once; the template is saved and reused for later files from the same export.',
      ],
      capabilities: IMPORT_CAPABILITIES,
      historyLimit: unverifiedHistory(null, 'Whatever period the downloaded file covers.'),
      fileKinds: ['csv', 'xlsx', 'pdf'],
      verificationLevel: 'implemented',
      documentationUrls: ['https://docs.mercury.com/docs/getting-started'],
      unsupportedProducts: ['A statement file carries no card metadata and no pending transactions unless the export includes them.'],
      scheduleSupported: false,
    }),
  ],
};

export const mercuryMcpProvider: ProviderDescriptor = {
  key: 'mercury_mcp',
  name: 'Mercury (MCP)',
  category: 'mcp',
  regions: ['US'],
  summary:
    'Mercury\'s hosted MCP server at https://mcp.mercury.com/mcp. Mercury states it issues a read-only token and that its hosted MCP has read-only access. Used for agent context, not as a source of record.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Verified on 2026-09-18 from https://docs.mercury.com/docs/connecting-mercury-mcp and the supported-tools page. Mercury documents Streamable HTTP, OAuth 2.0 with RFC 7591 dynamic client registration and PKCE, endpoints /register, /authorize and /token, scopes "read" plus "offline_access" for refresh tokens, and resource=https://mcp.mercury.com/mcp. Two documented quirks are handled: a 401 from the MCP server carries no resource_metadata pointer, and protected-resource metadata is published only at the root well-known path, so discovery falls back to the root. All 31 documented tools are getters. Tool output reaches FinancialOS as inert, size-capped data; it never becomes a balance or a ledger entry.',
  methods: [
    readOnlyMethod({
      method: 'mcp_oauth',
      label: 'OAuth (MCP)',
      description: 'Authorize FinancialOS against Mercury\'s MCP server. Only tools that pass the read-only check are callable, and the response is treated as untrusted data.',
      fields: [
        urlField('serverUrl', 'MCP server URL', 'Default https://mcp.mercury.com/mcp. Change it only if Mercury publishes a new endpoint.', false),
        textField('scope', 'Requested scope', 'Default "read offline_access". offline_access is what Mercury documents for refresh tokens.', false),
      ],
      ownerActivationSteps: [
        'Open this connection and press Connect. FinancialOS discovers Mercury\'s authorization server and registers itself dynamically.',
        'A Mercury sign-in page opens in your browser. Sign in and approve read access for the business you want.',
        'Mercury redirects back to FinancialOS, which exchanges the code and stores the tokens encrypted.',
        'Press Test to list the tools Mercury exposes and see which ones passed the read-only check.',
      ],
      capabilities: capabilities({
        agentContext: yes('Read-only tool calls whose output is returned as inert data for the coach and the agent API.'),
        balances: no('MCP output is free-form text from a remote server. Balances of record come from the Mercury REST connection.'),
        transactions: no('MCP output is free-form text from a remote server. Transactions of record come from the Mercury REST connection.'),
      }),
      historyLimit: unverifiedHistory(null, 'Whatever the tool returns. Mercury documents no history limit for MCP.'),
      fileKinds: [],
      verificationLevel: 'implemented',
      documentationUrls: ['https://docs.mercury.com/docs/connecting-mercury-mcp', 'https://docs.mercury.com/docs/supported-tools-on-mercury-mcp'],
      unsupportedProducts: [
        'Any tool whose name carries an action verb is refused before it is called, even if Mercury were to add one.',
        'MCP results are never written to the ledger.',
      ],
      scheduleSupported: false,
    }),
  ],
};
