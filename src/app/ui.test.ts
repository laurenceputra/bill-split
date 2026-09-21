import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AuthLoadingShell, Field, SplitTransactionControl } from './ui';

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

describe('SplitTransactionControl', () => {
  it('renders an accessible scoped primary link and native transaction select', () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/groups/group-1'] }, createElement(SplitTransactionControl, { groupId: 'group-1', online: true })));

    expect(markup).toContain('href="/groups/group-1/expense/new"');
    expect(markup).toContain('aria-label="Add expense"');
    expect(markup).toContain('aria-label="Choose transaction type"');
    expect(markup).toContain('value="refund"');
    expect(markup).toContain('value="payment"');
  });

  it('keeps the global chooser primary and exposes offline alternatives as disabled options', () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(SplitTransactionControl, { online: false, compact: true })));

    expect(markup).toContain('href="/add"');
    expect(markup).toContain('Refund/reimbursement (choose a group first)');
    expect(markup).toContain('Payment between members (choose a group first)');
    expect(markup).toMatch(/value="refund" disabled/);
    expect(markup).toMatch(/value="payment" disabled/);
    expect(markup).toMatch(/<select[^>]+aria-describedby=[^>]+disabled/);
    expect(markup).toContain('More transaction types unavailable: Choose a group first to record a refund or payment.');
  });

  it('does not put current-page semantics on a primary link unless explicitly told it is current', () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/groups/group-1/refund/new'] }, createElement(SplitTransactionControl, { groupId: 'group-1', online: true, active: true })));
    expect(markup).not.toContain('aria-current="page"');
    const currentMarkup = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/groups/group-1/expense/new'] }, createElement(SplitTransactionControl, { groupId: 'group-1', online: true, primaryCurrent: true })));
    expect(currentMarkup).toContain('aria-current="page"');
  });

  it('disables the scoped alternatives menu offline without disabling Add expense', () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/groups/group-1'] }, createElement(SplitTransactionControl, { groupId: 'group-1', online: false })));
    expect(markup).toContain('href="/groups/group-1/expense/new"');
    expect(markup).toContain('Refund/reimbursement (online only)');
    expect(markup).toContain('Payment between members (online only)');
    expect(markup).toContain('title="Refunds and payments require a connection."');
    expect(markup).toMatch(/<select[^>]+disabled/);
  });

  it('keeps the mobile navigation plus decorative and uses the shared content track', () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/groups/group-1'] }, createElement(SplitTransactionControl, { groupId: 'group-1', online: true, compact: true, mobileNav: true })));

    expect(markup).toContain('class="nav-item__content"');
    expect(markup).toContain('class="nav-item__icon"');
    expect(markup).toContain('class="nav-item__glyph nav-item__glyph--add"');
    expect(markup).toContain('class="nav-item__label">Add</span>');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('nav-add-stack');
    expect(markup).not.toContain('nav-add-icon');
    expect(markup).toContain('aria-label="Add expense"');
    expect(markup).toContain('aria-label="Choose transaction type"');
  });
});

describe('AuthLoadingShell', () => {
  it('keeps every loading nav placeholder on the shared two-row track', () => {
    const markup = renderToStaticMarkup(createElement(AuthLoadingShell));

    expect(markup.match(/class="nav-item__content"/g)).toHaveLength(4);
    expect(markup.match(/class="nav-item__icon"/g)).toHaveLength(4);
    expect(markup.match(/class="nav-item__label"/g)).toHaveLength(4);
    expect(markup.match(/skeleton--nav-icon/g)).toHaveLength(4);
    expect(markup.match(/skeleton--nav-label/g)).toHaveLength(4);
    expect(markup).toContain('class="nav-item nav-item--add"');
    expect(markup).toContain('class="nav-item__capsule"');
    expect(markup).toContain('aria-hidden="true"');
  });
});
