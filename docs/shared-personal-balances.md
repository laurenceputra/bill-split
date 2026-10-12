# Client personal balances

`personal-balances.ts` owns the latest complete snapshot per internal user and
group. Both API sources submit to a transactional revision comparison in the
existing IndexedDB `groupSnapshots` store (no schema/version bump). Equal revision
responses refresh freshness; lower revisions and absent snapshots cannot regress
the canonical record. Currency arrays replace, rather than merge.

Legacy home summaries and full breakdown caches are fallback data, not complete
personal maps. The Home display/sort overlays canonical values; group overview
uses the same canonical record when available. Full ledger breakdown remains an
independent resource and refreshes when it trails the canonical revision.

Mutation invalidation fences memory before awaiting persisted invalidation and
then starts visible refreshes. Persisted balance freshness is staled alongside
transaction invalidation. Completion sends scoped amount-free BroadcastChannel
and storage hints, with bounded deduplication and no receiver echo. Hidden tabs
defer requests to foreground coordination. The existing coordinator polls only
subscribed list/balance sources every 30 seconds, without polling identity.

Settlement suggestions are suppressed on stale resources and automatic pair
amount updates do not overwrite dirty drafts.

## Verification limits

Focused unit coverage exercises both API sources in reverse revision order,
transactional persistence, empty/removal snapshots, account isolation, persisted
invalidation ordering, hint isolation/deduplication, and polling authentication
lifecycle. Existing browser tests cover mobile primary-action order and online,
cached, error, and offline group views. Full multi-tab browser/session-switch
stress and the complete responsive screenshot matrix remain follow-up checks.
