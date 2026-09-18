import type { ProviderDescriptor } from '@financialos/contracts';
import {
  CHECKED_ON,
  capabilities,
  no,
  numberField,
  readOnlyMethod,
  secretField,
  textField,
  unverifiedHistory,
  urlField,
  yes,
} from './support';

const FLEX_DOCS = [
  'https://www.ibkrguides.com/clientportal/performanceandstatements/flex3.htm',
  'https://www.interactivebrokers.com/docs/web-api/flex-web-service/introduction',
  'https://www.interactivebrokers.com/docs/web-api/flex-web-service/using-flex-web-service/generate-the-report',
  'https://www.interactivebrokers.com/docs/web-api/flex-web-service/using-flex-web-service/retrieve-the-report',
  'https://www.interactivebrokers.com/docs/web-api/flex-web-service/client-portal-configuration/enable-and-create-access-token',
  'https://www.interactivebrokers.com/docs/web-api/flex-web-service/error-codes',
];

export const ibkrProvider: ProviderDescriptor = {
  key: 'ibkr',
  name: 'Interactive Brokers',
  category: 'broker',
  regions: ['US', 'GB', 'EU', 'Global'],
  summary:
    'Brokerage positions, trades, cash movements, and conversion rates through the Flex Web Service, plus IBKR\'s hosted MCP server for agent context. No order is ever placed from FinancialOS.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Flex verified on 2026-09-18: SendRequest returns a reference code, GetStatement returns the report, version 3 is the documented version, the <url> element in the response must be ignored, a User-Agent header is required, and the documented pacing limit is one request per second and ten per minute per token. The full version 3 error-code list is implemented, including 1012 token expired, 1013 IP restriction, 1015 token invalid, 1018 too many requests, and 1019 statement generation in progress. The Flex token travels in the query string, so every log line and error message from this adapter is passed through a redactor that removes it. Statement prices are statement marks, not real-time or delayed quotes. IBKR MCP: the public page gives the endpoint and states that instructions never become orders automatically, but publishes neither the transport nor the OAuth version nor a tool list, so those are reported as unverified.',
  methods: [
    readOnlyMethod({
      method: 'flex_web_service',
      label: 'Flex Web Service token',
      description: 'A Flex Web Service token plus an Activity Flex Query id. FinancialOS requests the statement and parses it; it never places, amends, or cancels anything.',
      fields: [
        secretField('flexToken', 'Flex Web Service token', 'The token generated in Client Portal. It is stored encrypted and is never written to a log or an error message.'),
        textField('queryId', 'Flex Query ID', 'The numeric id of the Activity Flex Query to run, shown next to the query in Client Portal.', true, '^\\d{1,20}$'),
        numberField('periodDays', 'Default period (days)', 'How many days each sync requests. IBKR allows at most 365 days per request.'),
        numberField('maxWaitMs', 'Maximum wait (ms)', 'How long to keep polling while IBKR reports "statement generation in progress". Default 300000.'),
        urlField('baseUrl', 'Flex service base URL', 'Override only if IBKR changes the Flex Web Service host.', false),
      ],
      ownerActivationSteps: [
        'Sign in to IBKR Client Portal with the master account (linked and advisor structures only show Flex on the master).',
        'Open Performance & Reports, then Flex Queries.',
        'Create an Activity Flex Query. Include at least Account Information, Open Positions, Trades, Cash Transactions, Cash Report, and Conversion Rates.',
        'Set the date format to yyyyMMdd and the output format to XML.',
        'Save the query and note its numeric Query ID.',
        'On the same Flex Queries page, open the Flex Web Service configuration and generate a token. Set "Should Expire After" to the longest period you are comfortable with (6 hours to 1 year; the default is 6 hours).',
        'If you set an IP restriction on the token, it must be the public address this deployment egresses from, otherwise IBKR returns error 1013.',
        'Paste the token and the Query ID into this connection and press Test. Generating a new token invalidates the previous one.',
      ],
      capabilities: capabilities({
        balances: yes('Ending cash per currency from the Cash Report section. These are statement balances, not a live provider balance.'),
        holdings: yes('Open Positions, aggregated from lot rows to one line per instrument and currency, with statement mark prices.'),
        investmentTransactions: yes('Trades at execution level plus cash transactions (dividends, withholding tax, interest, fees, deposits and withdrawals).'),
        statements: yes('The retrieved Flex statement is the evidence for every row it produced.'),
        transactions: no('Bank-style transactions do not exist at a broker; cash movements are recorded as investment transactions.'),
        agentContext: no('Use the IBKR MCP method for agent context.'),
      }),
      historyLimit: unverifiedHistory(
        365,
        'IBKR documents a maximum period of 365 days per request (parameter p), or an explicit fd/td pair. Longer histories need several runs. No live account has been connected, so no verified depth can be stated.',
      ),
      fileKinds: ['ibkr_flex_xml', 'ibkr_flex_csv'],
      verificationLevel: 'implemented',
      documentationUrls: FLEX_DOCS,
      unsupportedProducts: [
        'Order entry, amendment, and cancellation: FinancialOS has no execution connector and the Flex service offers none.',
        'Real-time quotes: Flex returns statement marks only.',
        'Accounts not included in the configured Flex Query are invisible; add them to the query in Client Portal.',
        'Legacy Flex Queries are rejected by IBKR with error 1010; use Activity Flex.',
      ],
      scheduleSupported: true,
    }),
    readOnlyMethod({
      method: 'mcp_oauth',
      label: 'IBKR MCP (agent context)',
      description:
        'IBKR\'s hosted MCP server. Only tools that pass the read-only check are callable. Order tools are excluded here, and IBKR itself requires every order to be reviewed and submitted in an IBKR platform.',
      fields: [urlField('serverUrl', 'MCP server URL', 'Default https://api.ibkr.com/v1/api/mcp-public, the endpoint IBKR publishes on its AI integrations page.', false)],
      ownerActivationSteps: [
        'Open https://www.interactivebrokers.com/en/trading/ai-integrations.php and read what your account may expose.',
        'In this connection, press Connect. FinancialOS performs OAuth discovery against the endpoint and reports exactly what the server answers.',
        'Complete the IBKR sign-in and approval in your browser.',
        'Press Test to see which tools IBKR exposes and which ones this deployment refused.',
        'If IBKR exposes order-related tools, FinancialOS refuses them. To place an order you must open the AI Instructions tab in an IBKR platform and review and submit it there.',
      ],
      capabilities: capabilities({
        agentContext: yes('Read-only tools only. Output is inert, size-capped data.'),
        holdings: no('Positions of record come from the Flex statement, which is auditable and dated.'),
        balances: no('Balances of record come from the Flex statement.'),
      }),
      historyLimit: unverifiedHistory(null, 'IBKR publishes no history limit for MCP and no tool list, so nothing can be stated.'),
      fileKinds: [],
      verificationLevel: 'implemented',
      documentationUrls: ['https://www.interactivebrokers.com/en/trading/ai-integrations.php'],
      unsupportedProducts: [
        'Order placement: every tool whose name carries an action verb (place, submit, cancel, modify, trade, buy, sell) is refused before it is called.',
        'IBKR states that instructions never become orders automatically and that the owner reviews and submits every order in an IBKR platform. FinancialOS never represents an MCP call as execution.',
        'IBKR does not publish the MCP transport, the OAuth version, or a tool list, so those remain unverified in this deployment.',
      ],
      scheduleSupported: false,
    }),
    readOnlyMethod({
      method: 'file_import',
      label: 'Flex statement file',
      description: 'Upload a Flex statement downloaded from Client Portal. Identical parsing to the web service, without a token.',
      fields: [],
      ownerActivationSteps: [
        'In Client Portal, run the Activity Flex Query and download the XML (or CSV) file.',
        'Upload it here and choose the account it belongs to.',
      ],
      capabilities: capabilities({
        holdings: yes('Open Positions from the file.'),
        investmentTransactions: yes('Trades and cash transactions from the file.'),
        balances: yes('Cash Report ending balances from the file.'),
        statements: yes('The uploaded file is kept as evidence.'),
      }),
      historyLimit: unverifiedHistory(null, 'Whatever period the downloaded statement covers.'),
      fileKinds: ['ibkr_flex_xml', 'ibkr_flex_csv'],
      verificationLevel: 'implemented',
      documentationUrls: ['https://www.ibkrguides.com/clientportal/performanceandstatements/flex3.htm'],
      unsupportedProducts: ['A statement covering several accounts must have each account mapped before it can be committed.'],
      scheduleSupported: false,
    }),
  ],
};
