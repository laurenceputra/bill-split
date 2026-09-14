import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Field } from './ui';

describe('Field', () => {
  it('de-duplicates an error ID already present in aria-describedby', () => {
    const markup = renderToStaticMarkup(createElement(Field, {
      label: 'Start date',
      error: 'Enter a real start date.',
      errorId: 'start-date-error',
      children: createElement('input', { 'aria-describedby': 'help-text start-date-error' }),
    }));

    expect(markup).toContain('aria-describedby="help-text start-date-error"');
    expect(markup.match(/start-date-error/g)).toHaveLength(2);
  });
});
