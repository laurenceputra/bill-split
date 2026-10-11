// Intentionally static: no app bundle, storage access, worker messages, or reload.
export const APP_UPDATE_RECOVERY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Recover a BillSplit update</title>
<style>body{font:1rem/1.6 system-ui,sans-serif;margin:0;color:#172235;background:#f5f7fb}main{max-width:42rem;margin:auto;padding:clamp(1rem,4vw,3rem)}h1{line-height:1.2}li{margin-block:1rem}a{color:#174ac0;overflow-wrap:anywhere}</style></head>
<body><main><h1>Recover a BillSplit update</h1>
<p>An older open app may not support safe automatic updates. This page does not apply an update or refresh your other tabs.</p>
<ol><li>Return to each BillSplit tab or installed app window. Let ongoing writes finish and save unfinished work. If work cannot be saved, keep that window open until it can.</li>
<li>Close <strong>all</strong> BillSplit tabs and installed app windows, including this recovery page. Closing only one tab may leave the old version running.</li>
<li>While connected to the internet, reopen BillSplit normally. The browser can then activate a downloaded update or check for a new one.</li></ol>
<p>Your saved local data and pending expenses are not cleared by this page. Do not clear site data, delete caches, or uninstall the app to update.</p>
<p>This page requires a network connection; it is not an offline recovery tool. If reopening still shows the old version, reconnect and check for updates, then repeat these steps. An update may not have downloaded yet.</p>
<p><a href="/">Return to BillSplit to save work</a> (this does not apply an update).</p>
</main></body></html>`;

export function appUpdateRecoveryResponse(method: string, headers: Headers): Response {
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return new Response(method === 'HEAD' ? null : APP_UPDATE_RECOVERY_HTML, { headers });
}
