import type { InputHTMLAttributes } from 'react';
import type { Currency } from '../shared/types';
import { currencyOptions } from '../shared/schemas';
import { amountFieldClass, amountInputClass, amountInputLength } from './form-helpers';

/** The expense amount shell, with either an editable currency or a fixed prefix. */
export function AmountControl({ currency, onCurrencyChange, ...input }: InputHTMLAttributes<HTMLInputElement> & { value: string; currency: Currency; onCurrencyChange?: (currency: Currency) => void }) {
  return <div className={`amount-control ${amountFieldClass(input.value)}`}><div className="expense-amount-control">
    {onCurrencyChange ? <select aria-label="Currency" value={currency} onChange={(event) => onCurrencyChange(event.target.value as Currency)}>{currencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <span className="amount-control__currency" aria-hidden="true">{currency}</span>}
    <input {...input} className={amountInputClass(input.value)} data-amount-length={amountInputLength(input.value)} inputMode="decimal" placeholder="0.00" />
  </div></div>;
}
