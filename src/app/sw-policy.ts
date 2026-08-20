export function extractShellAssetPaths(html: string, origin: string): string[] {
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)].flatMap((match) => {
    try { const url = new URL(match[1], origin); return url.origin === origin && /^\/assets\/[a-zA-Z0-9._-]+\.(?:js|css|svg|png|webp|woff2?)$/.test(url.pathname) ? [url.pathname] : []; } catch { return []; }
  });
  return [...new Set(assets)];
}

export function cacheControlAllowsStorage(value: string | null | undefined) {
  return !/(?:^|,)\s*(?:private|no-store)(?:\s*(?:,|$)|=)/i.test(value || '');
}

export function isSafeFinalResponse(input: { ok: boolean; redirected: boolean; responseUrl: string; expectedOrigin: string; expectedPath: string; contentType?: string | null; cacheControl?: string | null }, expectedType?: RegExp) {
  try {
    const url = new URL(input.responseUrl);
    const protectedPath = url.pathname.startsWith('/api') || url.pathname.startsWith('/cdn-cgi/') || url.pathname.startsWith('/access');
    return input.ok && !input.redirected && !protectedPath && url.origin === input.expectedOrigin && url.pathname === input.expectedPath && cacheControlAllowsStorage(input.cacheControl) && (!expectedType || expectedType.test(input.contentType || ''));
  } catch { return false; }
}
