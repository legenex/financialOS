import { describe, expect, it } from 'vitest';
import { CsvWriter, neutraliseCell, quoteField, toCsv } from './index';

describe('neutraliseCell', () => {
  it.each([
    ['=HYPERLINK("http://example.com","x")', `'=HYPERLINK("http://example.com","x")`],
    ['+1+cmd|\' /C calc\'!A0', `'+1+cmd|' /C calc'!A0`],
    ['-2+3+cmd|\' /C calc\'!A0', `'-2+3+cmd|' /C calc'!A0`],
    ['@SUM(A1:A2)', `'@SUM(A1:A2)`],
    ['\t=1+1', `'\t=1+1`],
    ['\r=1+1', `'\r=1+1`],
    ['  =1+1', `'  =1+1`],
    ['\uFF1D1+1', `'\uFF1D1+1`],
    ['Coffee shop', 'Coffee shop'],
    ['', ''],
  ])('neutralises %j', (input, expected) => {
    expect(neutraliseCell(input)).toBe(expected);
  });

  it('keeps pure negative decimals only in numeric columns', () => {
    expect(neutraliseCell('-1234.50', true)).toBe('-1234.50');
    expect(neutraliseCell('-1234.50', false)).toBe(`'-1234.50`);
    expect(neutraliseCell('-1+1', true)).toBe(`'-1+1`);
    expect(neutraliseCell('-1e5', true)).toBe(`'-1e5`);
    expect(neutraliseCell('+12', true)).toBe(`'+12`);
  });
});

describe('quoteField', () => {
  it('quotes per RFC 4180', () => {
    expect(quoteField('plain')).toBe('plain');
    expect(quoteField('a,b')).toBe('"a,b"');
    expect(quoteField('say "hi"')).toBe('"say ""hi"""');
    expect(quoteField('line\nbreak')).toBe('"line\nbreak"');
    expect(quoteField(' padded')).toBe('" padded"');
    expect(quoteField('a;b', ';')).toBe('"a;b"');
  });
});

describe('toCsv', () => {
  it('writes a header and neutralised rows with CRLF line endings', () => {
    const csv = toCsv(
      ['Date', 'Description', 'Amount'],
      [
        ['2026-01-02', '=cmd|"/C calc"!A0', '-45.10'],
        ['2026-01-03', 'Example Holdings Ltd, invoice', '1200.00'],
        ['2026-01-04', null, '-0.5'],
      ],
      { numericColumns: ['Amount'] },
    );
    expect(csv).toBe(
      'Date,Description,Amount\r\n' +
        `2026-01-02,"'=cmd|""/C calc""!A0",-45.10\r\n` +
        '2026-01-03,"Example Holdings Ltd, invoice",1200.00\r\n' +
        '2026-01-04,,-0.5\r\n',
    );
  });

  it('neutralises header cells and supports a BOM', () => {
    const writer = new CsvWriter(['=bad', 'ok'], { bom: true, lineEnding: '\n' });
    expect(writer.header()).toBe("\uFEFF'=bad,ok\n");
  });

  it('rejects unsafe numbers and mismatched rows', () => {
    expect(() => toCsv(['a'], [[0.1]])).toThrow(TypeError);
    expect(() => toCsv(['a', 'b'], [['x']])).toThrow(RangeError);
    expect(() => new CsvWriter(['a'], { numericColumns: ['missing'] })).toThrow(RangeError);
  });
});
