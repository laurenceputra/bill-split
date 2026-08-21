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
    const protectedPath = isPrivatePath(url.pathname);
    return input.ok && !input.redirected && !protectedPath && url.origin === input.expectedOrigin && url.pathname === input.expectedPath && cacheControlAllowsStorage(input.cacheControl) && (!expectedType || expectedType.test(input.contentType || ''));
  } catch { return false; }
}

export function isSafeShellNavigation(input: { ok: boolean; redirected: boolean; responseUrl: string; expectedOrigin: string; requestedPath: string; contentType?: string | null; cacheControl?: string | null }, html: string) {
  try {
    const url = new URL(input.responseUrl);
    const protectedPath = isPrivatePath(url.pathname);
    const finalPathAllowed = url.pathname === input.requestedPath || url.pathname === '/' || url.pathname === '/index.html';
    return input.ok && !input.redirected && !protectedPath && finalPathAllowed && url.origin === input.expectedOrigin && /text\/html/i.test(input.contentType || '') && cacheControlAllowsStorage(input.cacheControl) && /id=["']root["']/.test(html) && extractShellAssetPaths(html, input.expectedOrigin).length > 0;
  } catch { return false; }
}

function isPrivatePath(pathname: string) {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/cdn-cgi' || pathname.startsWith('/cdn-cgi/') || pathname === '/sign-in' || pathname.startsWith('/sign-in/') || pathname === '/sign-up' || pathname.startsWith('/sign-up/');
}
