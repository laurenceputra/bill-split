import { describe, expect, it } from 'vitest';
import { escapeCsvCell, settlementCsvRow } from './csv';
import { assembleCsvPages } from '../app/export';

describe('CSV formula protection', () => {
  it('checks all leading whitespace before allowing a cell', () => {
    for (const prefix of ['', ' ', '\t', '\n', '\r', ' \t\r\n']) {
      expect(escapeCsvCell(`${prefix}=SUM(A1)`)).toBe(`"'${prefix}=SUM(A1)"`);
      expect(escapeCsvCell(`${prefix}+1`)).toBe(`"'${prefix}+1"`);
      expect(escapeCsvCell(`${prefix}-1`)).toBe(`"'${prefix}-1"`);
      expect(escapeCsvCell(`${prefix}@cmd`)).toBe(`"'${prefix}@cmd"`);
    }
  });

  it('quotes ordinary values and doubles embedded quotes', () => {
    expect(escapeCsvCell('safe "text"')).toBe('"safe ""text"""');
  });

  it('serializes settlement rows with formula-safe cells', () => {
    expect(settlementCsvRow({ date: '2026-01-01', fromPersonId: '=payer', toPersonId: 'person-b', amountMinor: 1250, currency: 'USD', note: 'paid, "in full"' })).toBe('"2026-01-01","\'=payer","person-b","1250","USD","paid, ""in full"""');
  });

  it('keeps a newline between paged expense CSV bodies after removing headers', () => {
    const header = 'date,description,amount_minor,currency,payers,splits';
    expect(assembleCsvPages([`${header}\nexpense-1`, `${header}\nexpense-2`], header)).toBe(`${header}\nexpense-1\nexpense-2`);
  });

  it('keeps a newline between paged settlement CSV bodies after removing headers', () => {
    const header = 'date,from_person,to_person,amount_minor,currency,note';
    expect(assembleCsvPages([`${header}\nsettlement-1`, `${header}\nsettlement-2`], header)).toBe(`${header}\nsettlement-1\nsettlement-2`);
  });
});
