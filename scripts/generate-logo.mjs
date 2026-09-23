// Rebuild the locally hosted icons from the supplied artwork. The source JPEG
// includes a white tile and shadow; only chromatic pixels within the mark's
// measured bounds are retained (including its pale lavender inner stroke).
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { discoverChromiumExecutable } from './playwright-browser-resolver.mjs';

const executablePath = process.env.BILLSPLIT_CHROME || (await discoverChromiumExecutable()).path;
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage();
  const source = (await readFile(new URL('./logo-source.jpg', import.meta.url))).toString('base64');
  const images = await page.evaluate(async (jpeg) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${jpeg}`;
    await image.decode();
    const input = document.createElement('canvas');
    input.width = image.width;
    input.height = image.height;
    const ctx = input.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, input.width, input.height);
    const output = document.createElement('canvas');
    output.width = output.height = 400;
    const out = output.getContext('2d');
    const clipped = out.createImageData(400, 400);
    // Artwork bounds: x=470..755, y=145..476. Leave breathing room around
    // the extracted mark. Sampling at native resolution avoids enlarging JPEG edges.
    const strengthMap = new Uint8Array(400 * 400);
    for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
      const sx = x + 412, sy = y + 111;
      const src = (sy * input.width + sx) * 4, dst = (y * 400 + x) * 4;
      const r = pixels.data[src], g = pixels.data[src + 1], b = pixels.data[src + 2];
      // The tile is near neutral; violet has blue appreciably above green.
      // Restrict extraction to the letter so purple shadow cannot leak in.
      const strength = Math.max(0, b - g);
      strengthMap[y * 400 + x] = sx >= 465 && sx <= 760 && sy >= 140 && sy <= 480 ? strength : 0;
       // Undo the JPEG's near-white matte at antialiased edges. Keep the
       // lavender interior: its chroma is genuine artwork, not background.
       const alpha = Math.max(0, Math.min(1, (strength - 10) / 26));
       const unmatte = (channel) => Math.max(0, Math.min(255, Math.round((channel - 250 * (1 - alpha)) / Math.max(alpha, 0.01))));
       clipped.data[dst] = unmatte(r);
       clipped.data[dst + 1] = unmatte(g);
       clipped.data[dst + 2] = unmatte(b);
      clipped.data[dst + 3] = Math.round(alpha * 255);
    }
    // Keep only the dominant connected letter silhouette; this removes
    // JPEG chroma noise and the faint violet tile shadow.
    const visited = new Uint8Array(400 * 400);
    const components = [];
    for (let i = 0; i < visited.length; i++) {
      if (visited[i] || strengthMap[i] < 32) continue;
      const queue = [i]; visited[i] = 1;
      for (let q = 0; q < queue.length; q++) {
        const n = queue[q], x = n % 400;
        for (const next of [x ? n - 1 : -1, x < 399 ? n + 1 : -1, n - 400, n + 400]) {
          if (next < 0 || next >= visited.length || visited[next] || strengthMap[next] < 32) continue;
          visited[next] = 1; queue.push(next);
        }
      }
      components.push(queue);
    }
    components.sort((a, b) => b.length - a.length);
    const keep = new Uint8Array(400 * 400);
    for (const component of components.slice(0, 2)) {
      if (component.length < 300) continue;
      for (const n of component) keep[n] = 1;
    }
     for (let i = 0; i < keep.length; i++) {
       if (keep[i]) continue;
       const x = i % 400;
       if (![i - 400, i + 400, x ? i - 1 : -1, x < 399 ? i + 1 : -1].some(n => keep[n])) clipped.data[i * 4 + 3] = 0;
       else clipped.data[i * 4 + 3] = Math.min(clipped.data[i * 4 + 3], 180);
    }
    out.putImageData(clipped, 0, 0);
    const render = (size, maskable = false) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const c = canvas.getContext('2d');
      if (maskable) {
        c.fillStyle = '#eee8fb';
        c.fillRect(0, 0, size, size);
        c.drawImage(output, size * .2, size * .2, size * .6, size * .6);
      } else {
        c.drawImage(output, 0, 0, size, size);
      }
      return canvas.toDataURL('image/png').split(',')[1];
    };
    return Object.fromEntries([
      ['logo-400.png', render(400)], ['icon-16.png', render(16)],
      ['icon-32.png', render(32)], ['icon-192.png', render(192)],
      ['icon-512.png', render(512)], ['icon-maskable-192.png', render(192, true)],
      ['icon-maskable-512.png', render(512, true)], ['apple-touch-icon.png', render(180, true)],
    ]);
  }, source);
  for (const [name, data] of Object.entries(images)) {
    await writeFile(new URL(`../public/icons/${name}`, import.meta.url), Buffer.from(data, 'base64'));
  }
  const png = images['logo-400.png'];
  await writeFile(new URL('../public/icons/icon.svg', import.meta.url),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><image width="400" height="400" href="data:image/png;base64,${png}"/></svg>\n`);
} finally {
  await browser.close();
}
