import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { DateInput } from './date-input';

describe('DateInput', () => {
  it('preserves native props and opens synchronously after the supplied click handler', () => {
    const order: string[] = [];
    const tree = create(<DateInput required min="2030-01-01" aria-label="Date" onClick={() => order.push('click')} />);
    const input = tree.root.findByType('input');
    expect(input.props).toMatchObject({ type: 'date', required: true, min: '2030-01-01', 'aria-label': 'Date' });
    expect(input.props.onFocus).toBeUndefined();
    input.props.onClick({ currentTarget: { showPicker: () => order.push('picker') } });
    expect(order).toEqual(['click', 'picker']);
    tree.unmount();
  });

  it.each(['disabled', 'readOnly', 'defaultPrevented'])('does not open when %s', (guard) => {
    const showPicker = vi.fn();
    const tree = create(<DateInput onClick={(event) => { if (guard === 'defaultPrevented') event.preventDefault(); }} />);
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, currentTarget: { showPicker, [guard]: true } };
    tree.root.findByType('input').props.onClick(event);
    expect(showPicker).not.toHaveBeenCalled();
    tree.unmount();
  });

  it('retains native fallback when showPicker is absent or throws', () => {
    const tree = create(<DateInput />);
    for (const showPicker of [undefined, () => { throw new Error('Unavailable'); }]) {
      expect(() => tree.root.findByType('input').props.onClick({ currentTarget: { showPicker } })).not.toThrow();
    }
    tree.unmount();
  });
});
