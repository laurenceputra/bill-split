# Historical update source snapshots

These are **verbatim source files**, not rewritten update adapters. Preserve their
original bytes (including whitespace and final newlines); do not format or modernize
them. `manifest.json` records each original repository path, full source commit,
SHA-256 and byte length. Those entries are the loader's explicit path whitelist.

| Snapshot | Source commit | Scope |
| --- | --- | --- |
| `oldest` | `f0cf823c93283ab0af780d3323eacd2f38128f3f` | Cache-first worker before page update coordination; actual v10 IDB and expense schema plus their session/money/type dependencies |
| `historical` | `53bda1d93de0a886427a2a4f6fed48b9b8e8cddc` | Explicit-update worker and page update/mutation modules plus their session dependency |

Only the required dependency closure is included: **8 TypeScript files and 2
worker JavaScript files**, totaling **109,965 bytes**. Type-only dependencies are
included so the snapshots remain self-contained sources, although the fixture's
esbuild transpilation erases them. No historical App, API/auth adapter, generated
bundle, asset set, or third-party dependency is vendored. The fixture uses the
repository's installed external packages (not a complete historical lockfile).

Normal tests work in shallow checkouts and source archives, with **no Git executable,
historical Git objects, or network retrieval**. `historical-sources.mjs` reads only
whitelisted files and checks their raw length/SHA-256 before transpilation or worker
placeholder substitution. Every server startup verifies the complete manifest;
`scripts/historical-update-fixtures.test.ts` also checks integrity and rejects
unknown/traversal paths and corruption. A missing/mismatched source fails rather
than silently using modern code. The existing fixture still substitutes only the
worker build placeholders and compiles TS normally; it does not change historical
update, storage, or schema logic.

## Optional regeneration / provenance check

Only maintainers regenerating snapshots need a full Git history containing the
commits above. From the repository root, the following reads the pinned Git blobs,
verifies them against the existing manifest, and materializes the same bytes. It
does not fetch history or update checksums to conceal source changes. All blobs
are verified before any file is written.

```sh
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { assertHistoricalSource, historicalManifest } from './tests/e2e/fixtures/historical-sources.mjs';
const files = [];
for (const [snapshot, { commit, files: entries }] of Object.entries(historicalManifest)) {
  for (const path of Object.keys(entries)) {
    const bytes = execFileSync('git', ['show', `${commit}:${path}`]);
    assertHistoricalSource(snapshot, path, bytes);
    files.push({ destination: `tests/e2e/fixtures/historical/${snapshot}/${path}`, bytes });
  }
}
for (const { destination, bytes } of files) writeFileSync(destination, bytes);
console.log(`Verified and materialized ${files.length} exact historical sources.`);
JS
```

After regeneration, run:

```sh
npx vitest run --config vitest.config.ts scripts/historical-update-fixtures.test.ts
node scripts/test-update-lifecycle-local.mjs
npm run typecheck
```

Adding a new historical dependency requires an explicit manifest entry copied
from its pinned Git blob and a matching vendored file. Do not broaden resolution
to the live `src/` tree. Updating a provenance pin is a deliberate test-fixture
change, not an automatic CI regeneration step.
