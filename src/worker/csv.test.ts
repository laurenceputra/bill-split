import { describe, expect, it } from 'vitest';
import { escapeCsvCell } from './csv';

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
});
