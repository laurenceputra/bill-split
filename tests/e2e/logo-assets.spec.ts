import { test, expect } from './fixtures';

test('logo artwork decodes with transparent corners and safe maskable bounds', async ({ page }) => {
  await page.goto('/');
  const samples = await page.evaluate(async () => {
    const results: Record<string, { corners: number[]; opaque: boolean; bounds: number[] | null; colored: number }> = {};
    for (const name of ['icon.svg', 'icon-16.png', 'icon-32.png', 'logo-400.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
      const image = new Image();
      image.src = `/icons/${name}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = image.width;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const corners = [0, image.width - 1, (image.width - 1) * image.width, image.width * image.width - 1].map(i => pixels[i * 4 + 3]);
      let minX = image.width, minY = image.height, maxX = -1, maxY = -1, colored = 0, opaque = true;
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4;
        if (pixels[i + 3] !== 255) opaque = false;
        // Purple mark is more chromatic than the solid lavender tile.
        if (pixels[i + 2] - pixels[i + 1] < 35 || pixels[i + 3] < 90) continue;
        colored++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      results[name] = { corners, opaque, bounds: colored ? [minX, minY, maxX, maxY] : null, colored };
    }
    return results;
  });
  for (const name of ['icon.svg', 'logo-400.png', 'icon-192.png', 'icon-512.png', 'icon-16.png', 'icon-32.png']) {
    expect(samples[name].corners).toEqual([0, 0, 0, 0]);
    expect(samples[name].colored).toBeGreaterThan(0);
  }
  for (const [name, size] of [['icon-maskable-192.png', 192], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]] as const) {
    expect(samples[name].opaque).toBe(true);
    expect(samples[name].bounds).not.toBeNull();
    const [left, top, right, bottom] = samples[name].bounds!;
    expect(Math.min(left, top)).toBeGreaterThanOrEqual(Math.floor(size * 0.2));
    expect(Math.max(right, bottom)).toBeLessThan(size * 0.8);
  }
});

for (const width of [390, 1440]) {
  test(`header logo renders and favicon loads at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    const logo = page.locator('header img.brand-logo').first();
    await expect(logo).toBeVisible();
    await expect(logo).toHaveJSProperty('naturalWidth', 400);
    const favicons = await page.evaluate(async () => {
      return Promise.all([...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')].map(async link => {
        const response = await fetch(link.href);
        const image = new Image();
        image.src = link.href;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = image.naturalWidth;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        const cornerAlpha = [0, canvas.width - 1, canvas.width * (canvas.height - 1), canvas.width * canvas.height - 1].map(i => data[i * 4 + 3]);
        let purplePixels = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 2] - data[i + 1] >= 35 && data[i + 3] >= 90) purplePixels++;
        }
        return { path: new URL(link.href).pathname, ok: response.ok, type: response.headers.get('content-type'), width: image.naturalWidth, cornerAlpha, purplePixels };
      }));
    });
    expect(favicons.map(icon => icon.path)).toEqual(['/icons/icon.svg', '/icons/icon-32.png', '/icons/icon-16.png']);
    for (const icon of favicons) {
      expect(icon.ok).toBe(true);
      expect(icon.type).toMatch(/image\//);
      expect(icon.cornerAlpha).toEqual([0, 0, 0, 0]);
      expect(icon.purplePixels).toBeGreaterThan(0);
    }
    expect(favicons[0].width).toBeGreaterThan(0); // SVG viewBox has no intrinsic pixel width.
    expect(favicons.slice(1).map(icon => icon.width)).toEqual([32, 16]);
  });
}
