import type { ColumnMapping } from '@financialos/contracts';

/** A reasonable starting mapping guessed from detected headers; the owner reviews and adjusts it. */
export function defaultMapping(headers: string[]): ColumnMapping {
  const find = (needles: string[]): string | null => headers.find((h) => needles.some((n) => h.toLowerCase().includes(n))) ?? null;
  const description = find(['description', 'narrative', 'memo', 'details']) ?? headers[0] ?? '';
  return {
    hasHeader: true,
    skipRows: 0,
    delimiter: null,
    sheetName: null,
    dateColumn: find(['date']) ?? headers[0] ?? '',
    valueDateColumn: null,
    dateFormat: 'YYYY-MM-DD',
    descriptionColumns: [description],
    counterpartyColumn: null,
    referenceColumn: find(['reference', 'ref']),
    balanceColumn: find(['balance']),
    currencyColumn: null,
    statusColumn: null,
    categoryColumn: null,
    amountMode: 'signed',
    amountColumn: find(['amount']),
    debitColumn: find(['debit']),
    creditColumn: find(['credit']),
    directionColumn: null,
    debitMarkers: [],
    negativeIsDebit: true,
    decimalSeparator: '.',
    thousandsSeparator: ',',
    defaultCurrency: 'USD',
    sourceTimezone: 'UTC',
  };
}
