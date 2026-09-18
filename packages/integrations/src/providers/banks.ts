import type { ProviderDescriptor } from '@financialos/contracts';
import { CHECKED_ON, IMPORT_CAPABILITIES, capabilities, readOnlyMethod, unverifiedHistory } from './support';

/**
 * Banks with no self-serve read API for an individual account holder.
 *
 * Each of these was checked against the institution's own pages on 2026-09-18. Where no official programme
 * exists, the descriptor says so and offers file import, which works the same day. No screen scraping, no
 * unofficial endpoint, and no aggregator is used, and no API is invented to make a screen look complete.
 */

const IMPORT_ONLY_UNSUPPORTED = (what: string) => [
  `Direct API access: ${what}`,
  'No screen scraping and no unofficial endpoint is used. Statement import is the supported path.',
];

export const revolutPersonalProvider: ProviderDescriptor = {
  key: 'revolut_personal',
  name: 'Revolut (personal)',
  category: 'bank',
  regions: ['GB', 'EU'],
  summary: 'Personal Revolut accounts. Statement import per currency account; no direct API is available to an individual account holder.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Checked on 2026-09-18. Revolut\'s "Who can access the API" page states that the Open Banking API is for Third Party Providers authorised under PSD2 as an AISP or PISP in the EU or UK, that a valid eIDAS or OBIE certificate is required to register an application for production, and that a regulated TPP needs no separate contract with Revolut. A single owner reading their own personal account is not an authorised TPP and cannot obtain such a certificate, so production Open Banking access is not available for this deployment. Revolut publishes no personal-account API for an individual account holder: its developer site offers Merchant, Open Banking, and Business tracks only. The Business API is explicitly for "a Revolut Business customer with a Business Account" and is never substituted for a personal account here. Revolut\'s help pages document personal statements per currency account as PDF or Excel; no CSV is documented for that flow.',
  methods: [
    readOnlyMethod({
      method: 'file_import',
      label: 'Statement import (per currency account)',
      description: 'Upload one statement per currency account. Cash, savings, and crypto are separate accounts and stay separate here.',
      fields: [],
      ownerActivationSteps: [
        'Open the Revolut app and go to Home.',
        'Tap Accounts and select the currency account you want (each currency is its own account).',
        'Tap More (...) and choose Statement.',
        'Select the timeframe and choose Excel (preferred here) or PDF, then tap Generate.',
        'Upload the file to FinancialOS and map the columns once; the template is reused afterwards.',
        'Repeat per currency account, and separately for savings and crypto: they are different accounts and must not be merged.',
      ],
      capabilities: IMPORT_CAPABILITIES,
      historyLimit: unverifiedHistory(null, 'Whatever timeframe you select when generating the statement.'),
      fileKinds: ['xlsx', 'csv', 'pdf'],
      verificationLevel: 'implemented',
      documentationUrls: [
        'https://developer.revolut.com/docs/guides/build-banking-apps/introduction-to-the-open-banking-api/who-can-access-the-api',
        'https://developer.revolut.com/docs/business/business-api',
        'https://help.revolut.com/en-US/help/profile-and-plan/managing-my-account/account-statement-per-chosen-currency/',
      ],
      unsupportedProducts: [
        'Direct API access: production Open Banking requires PSD2 authorisation as an AISP or PISP plus an eIDAS or OBIE certificate. An individual reading their own account does not qualify.',
        'The Revolut Business API covers Business Accounts only and is never used to read a personal account.',
        'Savings vaults and crypto are separate accounts; each needs its own statement and its own FinancialOS account.',
      ],
      scheduleSupported: false,
    }),
  ],
};

export const wioPersonalProvider: ProviderDescriptor = {
  key: 'wio_personal',
  name: 'Wio Personal',
  category: 'bank',
  regions: ['AE'],
  summary: 'Wio Personal (UAE). No official public developer programme was found; statement import works immediately.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Checked on 2026-09-18. wio.io publishes no developer, API, or documentation page (its own sitemap lists product, legal, and support pages only), and developer/api/docs subdomains do not resolve. An open-banking consent portal exists at ob.business.wio.io, whose manifest names it the "Wio Business Consent app"; that is a consent surface for authorised third parties, not developer documentation, and it is not a self-serve route for an account holder. Public Postman workspaces appear in search results but could not be verified as official, so they are not used. Direct API access is therefore marked unsupported until an official programme can be verified.',
  methods: [
    readOnlyMethod({
      method: 'file_import',
      label: 'Statement import',
      description: 'Upload a statement exported from the Wio app or web banking.',
      fields: [],
      ownerActivationSteps: [
        'Open Wio Personal and select the account.',
        'Export or download the statement for the period you need, in whatever format Wio offers (commonly PDF; use CSV or Excel if offered).',
        'Upload it to FinancialOS and confirm the column mapping once.',
      ],
      capabilities: IMPORT_CAPABILITIES,
      historyLimit: unverifiedHistory(null, 'Whatever period the exported statement covers.'),
      fileKinds: ['pdf', 'csv', 'xlsx'],
      verificationLevel: 'implemented',
      documentationUrls: ['https://wio.io/'],
      unsupportedProducts: IMPORT_ONLY_UNSUPPORTED('no official public developer programme or API documentation could be verified on 2026-09-18.'),
      scheduleSupported: false,
    }),
  ],
};

export const wioBusinessProvider: ProviderDescriptor = {
  key: 'wio_business',
  name: 'Wio Business',
  category: 'bank',
  regions: ['AE'],
  summary: 'Wio Business (UAE). No official public developer programme was verified; statement and holdings import work immediately.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Checked on 2026-09-18, the same evidence as Wio Personal. An open-banking consent app is served at ob.business.wio.io, which implies Wio participates in UAE open banking as an account-servicing institution, but consent portals serve licensed third parties and no public developer documentation, sandbox, or self-serve key issuance was found. Direct API access stays unsupported until that can be verified.',
  methods: [
    readOnlyMethod({
      method: 'file_import',
      label: 'Statement import',
      description: 'Upload a statement exported from Wio Business.',
      fields: [],
      ownerActivationSteps: [
        'Open Wio Business and select the account.',
        'Download the statement for the period you need.',
        'Upload it to FinancialOS, choose the legal entity, and confirm the column mapping once.',
      ],
      capabilities: IMPORT_CAPABILITIES,
      historyLimit: unverifiedHistory(null, 'Whatever period the exported statement covers.'),
      fileKinds: ['pdf', 'csv', 'xlsx'],
      verificationLevel: 'implemented',
      documentationUrls: ['https://wio.io/', 'https://ob.business.wio.io/'],
      unsupportedProducts: IMPORT_ONLY_UNSUPPORTED('no official public developer programme or API documentation could be verified on 2026-09-18. The open-banking consent portal is for licensed third parties, not for an account holder.'),
      scheduleSupported: false,
    }),
  ],
};

export const discoveryProvider: ProviderDescriptor = {
  key: 'discovery',
  name: 'Discovery Bank',
  category: 'bank',
  regions: ['ZA'],
  summary: 'Discovery Bank (South Africa). No official public developer programme was found; the app exports transactions in a format FinancialOS can import.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Checked on 2026-09-18. No Discovery Bank developer portal, sandbox, or API catalogue was found, and developer.discovery.co.za does not resolve. Discovery\'s own pages do document exports: certified bank statements for up to three months can be downloaded from the app, and transaction lists can be exported by choosing a file format (Excel or CSV) and a date range, which is then emailed to the profile address. The file type of the certified statement is not named on those pages, so it is not asserted here. Direct API access is unsupported. Screen scraping is not used.',
  methods: [
    readOnlyMethod({
      method: 'file_import',
      label: 'Statement and transaction export import',
      description: 'Upload the CSV or Excel transaction export, or the downloaded statement.',
      fields: [],
      ownerActivationSteps: [
        'Open the Discovery Bank app and select the account.',
        'Use Download Transactions, complete the date range, and choose a file format (Excel or CSV).',
        'Send or download the file; the app emails it to the address on your profile when you choose Send.',
        'Upload the file to FinancialOS and confirm the column mapping once.',
        'For a certified statement, use the statement download in the app (up to three months at a time) and upload that as a PDF.',
      ],
      capabilities: IMPORT_CAPABILITIES,
      historyLimit: unverifiedHistory(null, 'The date range you choose in the app. Certified statements are documented as up to three months per download.'),
      fileKinds: ['csv', 'xlsx', 'pdf'],
      verificationLevel: 'implemented',
      documentationUrls: [
        'https://www.discovery.co.za/bank/',
        'https://www.discovery.co.za/bank/info-and-tips-managing-your-accounts',
        'https://www.discovery.co.za/bank/blog-bank-app-paperless-finances-with-smart-vault',
      ],
      unsupportedProducts: IMPORT_ONLY_UNSUPPORTED('no official public developer programme or API documentation could be verified on 2026-09-18.'),
      scheduleSupported: false,
    }),
  ],
};

export const fnbProvider: ProviderDescriptor = {
  key: 'fnb',
  name: 'FNB',
  category: 'bank',
  regions: ['ZA'],
  summary:
    'First National Bank (South Africa). The Integration Channel offers APIs and Host-to-Host to business clients through bank onboarding; it is not configured. Statement import works immediately.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Checked on 2026-09-18 against https://www.online.fnb.co.za/integration-channel/index.html. The page describes the Integration Channel as a way for a business, as a FirstRand client, to consume the bank\'s services "using APIs or Host-to-Host". The documented services are DebiCheck, EFT Collections, EFT Payments, 3rd Party Investment Manager (3PIM), Proof of Payments, Transaction History ("Retrieve a summary of your account transactions over a set period using parameters such as Account number, From date and To Date"), and two monthly push messages (Trancode List and Global Recipient List). Onboarding is not self-serve: the qualifying criterion is an Online Banking profile and the page directs applicants to a Client Service Manager or Digital Portfolio Manager, or a phone number. No public API catalogue or developer portal was reachable, and api/developer subdomains do not resolve. Transaction History would be the relevant read service, but it requires bank onboarding and is therefore recorded as "requires bank onboarding - not configured".',
  methods: [
    readOnlyMethod({
      method: 'file_import',
      label: 'Statement import',
      description: 'Upload an FNB statement or transaction export. Available today, with no bank onboarding.',
      fields: [],
      ownerActivationSteps: [
        'Sign in to FNB Online Banking and open the account.',
        'Download the statement or transaction history for the period you need (CSV or PDF).',
        'Upload it to FinancialOS and confirm the column mapping once; day-first dates and a running balance column are common in these exports.',
      ],
      capabilities: IMPORT_CAPABILITIES,
      historyLimit: unverifiedHistory(null, 'Whatever period the downloaded file covers.'),
      fileKinds: ['csv', 'ofx', 'pdf', 'xlsx'],
      verificationLevel: 'implemented',
      documentationUrls: ['https://www.online.fnb.co.za/integration-channel/index.html'],
      unsupportedProducts: [
        'Integration Channel API and Host-to-Host: requires bank onboarding - not configured. It is a business channel onboarded through a Client Service Manager or Digital Portfolio Manager, not a self-serve developer programme.',
        'Payment and collection services in that channel (EFT Payments, EFT Collections, DebiCheck) are out of scope entirely: FinancialOS is read-only.',
        'No public API catalogue or developer portal was reachable on 2026-09-18.',
      ],
      scheduleSupported: false,
    }),
    readOnlyMethod({
      method: 'none',
      label: 'Integration Channel (not configured)',
      description:
        'Placeholder for FNB\'s Integration Channel Transaction History service. It exists for business clients but needs bank onboarding, so this deployment cannot activate it.',
      fields: [],
      ownerActivationSteps: [
        'Sign in to FNB Online Banking (the page states this is the qualifying criterion for the full channel offering).',
        'Open https://www.online.fnb.co.za/integration-channel/index.html and read the "How to apply" and "What you need" sections.',
        'Contact your FNB Client Service Manager or Digital Portfolio Manager, or call the Integration Channel line listed on that page.',
        'Ask specifically for the read-only Transaction History service. Do not enable EFT Payments, EFT Collections, or DebiCheck: FinancialOS neither needs nor supports them.',
        'If FNB onboards the account, come back here with the channel details; this method will need implementing against the contract FNB supplies, because it is not published.',
      ],
      capabilities: capabilities({}, 'Requires bank onboarding - not configured.'),
      historyLimit: unverifiedHistory(null, 'Not configured. The public page does not state a history depth for Transaction History.'),
      fileKinds: [],
      verificationLevel: 'implemented',
      documentationUrls: ['https://www.online.fnb.co.za/integration-channel/index.html'],
      unsupportedProducts: [
        'Everything: this method is not configured and performs no request.',
        'The API contract is not published, so nothing can be implemented against it in advance.',
      ],
      scheduleSupported: false,
    }),
  ],
};
