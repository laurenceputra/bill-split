export const STARTUP_FAILURE_CATEGORIES = Object.freeze({
  setup: 'setup/code',
  runtime: 'runtime/environment',
});

export function setupFailure(type = 'setup-failure') {
  return { type, category: STARTUP_FAILURE_CATEGORIES.setup };
}

export function runtimeFailure(type = 'runtime-failure') {
  return { type, category: STARTUP_FAILURE_CATEGORIES.runtime };
}

/**
 * Playwright terminates a webServer command when its readiness URL does not
 * become reachable before the webServer timeout. A user interrupt should not
 * create a release-gate marker, but an external SIGTERM before readiness is a
 * runtime/environment startup timeout.
 */
export function classifyTermination({ signal, ready }) {
  return signal === 'SIGTERM' && !ready ? runtimeFailure('startup-timeout') : undefined;
}
