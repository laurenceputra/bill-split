# Verification tiers and evidence ownership

| Tier | Command / owner | Purpose |
| --- | --- | --- |
| Required unit/source contracts | `npm run test:unit` | Fast isolated behavior and static contracts; no local-D1 migration execution |
| Required integration | `npm run test:integration` | Real local-D1 summary checks and the dedicated migration suite |
| Optional performance | `npm run test:performance` | Large workloads and query plans, outside normal required tests |
| Browser behavior | `npm run test:e2e` | Chromium behavior, accessibility semantics, offline/recovery, responsive audits and real service-worker lifecycle |
| Focused cross-browser dates | `date-controls.spec.ts`, Chromium and `date-controls-webkit` | Semantic/value/route wiring: 13 routes at 390px; geometry: eight representative layouts at 320, 390, 767, 768, 895, 896, 1440px. This is 69 route visits per browser, 138 across both (about 24% fewer than 182) |
| Manual screenshot generation | Commands below | Curated tracked references, not an extra normal behavior gate |

The dedicated migration suite selected by `vitest.migration.config.ts` is the
sole integration owner of migration application and schema/trigger regression
coverage. Unit source contracts do not replace it, and summary integration tests
exercise runtime queries rather than duplicating migration assertions.

`service-worker-update.spec.ts` currently expands to **10 standalone Chromium
lifecycle cases** (eight direct cases and two installation-failure variants).
These use the coherent A/B production-core fixture, not an authenticated full-app
A/B migration audit. Endpoint and application behavior suites have separate
owners and must not be counted as lifecycle cases.

## Repeatable synthetic references

```sh
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:screenshots:group
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm run test:screenshots:home
# Optional focused overview refresh (five images):
GROUP_SCREENSHOTS_OVERVIEW_ONLY=1 npm run test:screenshots:group
```

For a bounded home-only refresh, append
`-- --grep 'Home reference|Home sort tooltip|Home cards retain'` to the home
command. The full home command also retains control-feedback behavior checks.

The local wrapper validates Chromium selection and passes screenshot environment
flags through. Group captures are explicitly skipped unless
`UPDATE_GROUP_SCREENSHOTS=1`; home behavior tests remain normal tests, with
`UPDATE_HOME_SCREENSHOTS=1` controlling tracked output. The group API responses
are anonymized before rendering, never blurred. Text and avatar checks precede
every capture. Internal example.com authentication contracts are not displayed.

Canonical references and disclosure links live in the
[responsive matrix](responsive-audit-matrix.md). Group overview, focused More
group actions, Changes and Insights retain mobile/desktop evidence; the mobile
viewport capture retains fixed navigation. Native select popup chrome requires
manual browser/device inspection. Full-page captures hide fixed bottom navigation
only after checking it live. References depict loaded synthetic data, not every
resource state: keep the matrix's narrow mobile, breakpoint, desktop, loading,
cached, offline, empty, error and accessibility checks as behavior coverage.
