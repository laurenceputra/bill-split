import type { Locator } from '@playwright/test';
import { expect } from './fixtures';

// Zero-size inline markers expose the text baselines without relying on glyph
// bounding boxes (bold amounts and regular labels have different ink bounds).
export async function expectInlineMoneyAligned(amounts: Locator) {
  expect(await amounts.count()).toBeGreaterThan(0);
  for (const amount of await amounts.all()) {
    const difference = await amount.evaluate(async (element) => {
      await document.fonts.ready;
      const marker = () => {
        const node = document.createElement('span');
        node.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline';
        return node;
      };
      const inside = marker();
      const outside = marker();
      element.append(inside);
      element.after(outside);
      try {
        return Math.abs(inside.getBoundingClientRect().top - outside.getBoundingClientRect().top);
      } finally {
        inside.remove();
        outside.remove();
      }
    });
    expect(difference, `Inline baseline for ${await amount.textContent()}`).toBeLessThan(1);
  }
}
