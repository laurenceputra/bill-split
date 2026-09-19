# Credit transaction responsive audit matrix

The credit flow is online-only and uses the existing mobile-first form shell.

| View/state | 390px mobile | 768px boundary | 1280px desktop |
| --- | --- | --- | --- |
| Record credit, loaded | Form controls remain in DOM order: type, delivery, amount, application, allocations, note, submit | Verify select/field wrapping and no horizontal overflow | Primary submit remains before secondary navigation |
| Record credit, loading/error | Loading status and inline error are announced; submit is disabled offline | Error text remains adjacent to the form | Error and retry remain content-sized |
| Credit detail, active | Application and allocation snapshots stack as rows; edit/delete follow detail | Verify rows wrap long IDs/notes | Actions remain below the accounting explanation |
| Credit detail, deleted/restore | Restore is the only available mutation and is disabled offline | Tombstone copy remains visible | Restore and error states remain readable without modal-only context |
| Transaction history | Credit rows use the same keyset list and disclosure filters | Credit kind filter does not expose category controls | Credit rows link to detail and preserve group context |

Direct-provider defaults and application-cap failures are also covered by the
API invariant tests; browser geometry coverage should include each populated
and empty application state when the local D1 fixture includes a credit.
