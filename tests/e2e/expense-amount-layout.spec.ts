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
           const shell = input.parentElement!;
           const field = shell.parentElement!;
          const currency = field.querySelector('select')!;
           const label = field.querySelector('label')!;
          const amountRect = input.getBoundingClientRect();
          const currencyRect = currency.getBoundingClientRect();
          const style = getComputedStyle(input);
          return {
            alignment: style.textAlign,
             fontSize: parseFloat(style.fontSize),
             shellWidth: shell.getBoundingClientRect().width,
             fieldWidth: field.getBoundingClientRect().width,
             border: getComputedStyle(shell).borderTopWidth,
             weight: style.fontWeight,
            amount: { x: amountRect.x, y: amountRect.y, right: amountRect.right, height: amountRect.height },
            currency: { x: currencyRect.x, y: currencyRect.y, right: currencyRect.right, height: currencyRect.height },
            labelGap: Math.min(amountRect.y, currencyRect.y) - label.getBoundingClientRect().bottom,
            fieldHeight: field.getBoundingClientRect().height,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
         expect(geometry.alignment).toBe('left');
         expect(geometry.shellWidth).toBe(geometry.fieldWidth);
         expect(geometry.border).toBe('1px');
         expect(geometry.weight).toBe('400');
         expect(geometry.fontSize).toBeGreaterThanOrEqual(16);
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
           expect(geometry.currency.right - geometry.currency.x).toBeCloseTo(104, 0);
           expect(geometry.fontSize).toBeGreaterThanOrEqual(24);
           expect(geometry.fontSize).toBeLessThanOrEqual(28);
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
      const currency = page.getByLabel('Expense currency');
      const shell = page.locator('.expense-amount-control');
      await currency.focus();
      await expect(currency).toBeFocused();
      await expect(shell).toHaveCSS('outline-style', 'solid');
      await expect(shell).toHaveCSS('outline-width', '2px');
      await currency.press('Tab');
      await expect(amount).toBeFocused();
      await expect(shell).toHaveCSS('outline-width', '2px');
      await amount.press('Shift+Tab');
      await expect(currency).toBeFocused();
      await page.getByLabel('Description', { exact: true }).fill('Amount validation');
      await amount.fill('not an amount');
      await page.getByRole('button', { name: 'Save expense', exact: true }).click();
      await expect(amount).toHaveAttribute('aria-invalid', 'true');
      const invalidColor = await amount.evaluate((input) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--color-debt-fg)';
        input.parentElement!.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(shell).toHaveCSS('border-top-color', invalidColor);
      await amount.focus();
      await expect(shell).toHaveCSS('outline-color', invalidColor);
      await currency.focus();
      await expect(shell).toHaveCSS('outline-color', invalidColor);
      await page.emulateMedia({ forcedColors: 'active' });
      const systemColors = await shell.evaluate((control) => {
        const probe = document.createElement('span');
        // Resolve the actual system palette without forced-color substitution.
        probe.style.forcedColorAdjust = 'none';
        control.append(probe);
        probe.style.color = 'CanvasText';
        const border = getComputedStyle(probe).color;
        probe.style.color = 'Highlight';
        const outline = getComputedStyle(probe).color;
        probe.remove();
        return { border, outline };
      });
      await expect(shell).toHaveCSS('border-top-color', systemColors.border);
      await expect(shell).toHaveCSS('outline-color', systemColors.outline);
      await amount.focus();
      await expect(shell).toHaveCSS('outline-color', systemColors.outline);
      await expect(shell).toHaveCSS('outline-style', 'solid');
      await expect(shell).toHaveCSS('outline-width', '2px');
    } finally {
      await context.close();
    }
  });
}
