# Product UI

- Put frequent tasks before admin tasks.
- Preserve mobile DOM order; use progressive disclosure and semantic components.
- Model distinct expected states, avoid impossible actions, use realistic responsive stress, and provide contextual help.

# UI Verification

- Check narrow mobile and desktop layouts.
- Represent every new or changed interactive view and meaningful disclosure/modal state in the responsive audit matrix, including narrow mobile, breakpoint boundaries, and desktop.
- Verify primary actions appear before management controls and cover loading, cached, offline, empty, and error states.
- Add a focused behavior test where practical.

# Screenshot and Demo Data

- Use exclusively synthetic, generic demo data for all screenshots, PR visual evidence, and demo captures. Never include real or personal-looking names/emails, personal avatars or avatar hashes, identifying initials, sensitive personal/medical contexts, or production/customer data.
- Prefer neutral labels such as `Demo user`, `Demo friend`, and `Sample project`, with generic synthetic amounts. Existing test authentication contract emails at example.com may remain internal but must not be rendered.
- Anonymize fixture/API data before rendering; do not rely on inherited fields or blur. Verify text and avatar identity before capture, and keep generation repeatable.
