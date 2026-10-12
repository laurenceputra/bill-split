// Curated references, not a Cartesian product of every state and viewport.
export const tabletReferences = new Set([
  ...[320, 768, 834, 1024, 1440].map((width) => `home-${width}`),
  'home-loading-768', 'home-empty-320', 'home-error-320',
  'home-cached-error-834', 'home-offline-help-834',
  'group-834', 'group-1024', 'group-breakdown-320',
  'changes-1024', 'transactions-834', 'insights-834', 'insights-custom-768',
  'payer-320', 'payer-768', 'payer-short-320', 'payer-short-834',
  'public-1440', 'safe-limit-group-320',
]);
