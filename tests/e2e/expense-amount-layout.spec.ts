import { test, expect, newAuthenticatedContext, BASE_URL } from './fixtures';

for (const width of [320, 390, 767, 768, 895, 896, 1440]) {
  test(`expense amount stays compact with native editing access at ${width}px`, async ({ browser }) => {
    const context = await newAuthenticatedContext(browser, undefined, { width, height: 1024 });
    const page = await context.newPage();
    try {
      await page.goto(`${BASE_URL}/groups/00000000-0000-4000-8000-000000003002/expense/new`);
      const amount = page.getByLabel('Expense amount');
      await expect(amount).toBeVisible();
      for (const [length, value] of [['normal', '420.00'], ['normal', '999999.99'], ['long', '123456789.01'], ['long', '123456789012.34'], ['very-long', '90071992547409.91']]) {
        await amount.fill(value);
        await expect(amount).toHaveAttribute('data-amount-length', length);
        const geometry = await amount.evaluate((input) => {
          const field = input.parentElement!;
          const currency = field.querySelector('select')!;
          const label = field.querySelector('span')!;
          const amountRect = input.getBoundingClientRect();
          const currencyRect = currency.getBoundingClientRect();
          const style = getComputedStyle(input);
          return {
            alignment: style.textAlign,
            fontSize: parseFloat(style.fontSize),
            amount: { x: amountRect.x, y: amountRect.y, right: amountRect.right, height: amountRect.height },
            currency: { x: currencyRect.x, y: currencyRect.y, right: currencyRect.right, height: currencyRect.height },
            labelGap: Math.min(amountRect.y, currencyRect.y) - label.getBoundingClientRect().bottom,
            fieldHeight: field.getBoundingClientRect().height,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        expect(geometry.alignment).toBe('left');
        expect(geometry.amount.height).toBeGreaterThanOrEqual(44);
        expect(geometry.currency.height).toBeGreaterThanOrEqual(44);
        expect(geometry.amount.right).toBeLessThanOrEqual(width);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        expect(geometry.labelGap).toBeLessThanOrEqual(8);
        if (length === 'very-long') {
          expect(geometry.amount.y).toBeGreaterThan(geometry.currency.y);
          expect(geometry.amount.x).toBeCloseTo(geometry.currency.x, 0);
        } else {
          expect(geometry.amount.x - geometry.currency.right).toBeGreaterThanOrEqual(0);
          expect(geometry.amount.x - geometry.currency.right).toBeLessThanOrEqual(8);
          expect(geometry.fieldHeight).toBeLessThan(100);
          if (width >= 768 && length === 'normal') expect(geometry.fontSize).toBe(44);
        }
        await expect(amount).toHaveValue(value);
        // The decimal input is native text (no type attribute), so oversized
        // values may scroll internally without losing their editable contents.
        expect(await amount.evaluate((input: HTMLInputElement) => input.type)).toBe('text');
        await amount.blur();
        const text = await amount.evaluate((input: HTMLInputElement) => {
          const style = getComputedStyle(input);
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d')!;
          context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const textWidth = context.measureText(input.value).width
            + (parseFloat(style.letterSpacing) || 0) * input.value.length;
          return {
            fits: textWidth <= input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2,
            scrollWidth: input.scrollWidth,
            clientWidth: input.clientWidth,
            scrollLeft: input.scrollLeft,
          };
        });
        // Chromium resets the left-aligned text to its start on blur.
        expect(text.scrollLeft).toBeLessThanOrEqual(1);
        if (text.fits) {
          expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 2);
        } else {
          await amount.focus();
          await amount.press('Home');
          await expect.poll(() => amount.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(0);
          await expect.poll(() => amount.evaluate((input) => input.scrollLeft)).toBeLessThanOrEqual(1);
          await amount.press('End');
          await expect.poll(() => amount.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(value.length);
          await expect(amount).toHaveValue(value);
        }
      }
      // Returning to a typical amount restores the inline layout.
      await amount.fill('12.50');
      await expect(page.locator('.amount-field')).toHaveClass(/amount-field--normal/);
    } finally {
      await context.close();
    }
  });
}
