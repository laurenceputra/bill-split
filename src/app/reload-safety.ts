/** Dependency-light, synchronous reload barrier. No session or storage imports. */
export const RELOAD_IDLE_MS = 5_000;
export const MAX_RELOAD_GATE_MS = 10_000;
export type ReloadSafetyState = Readonly<{ reason?: string; operations: number; gated: boolean; lastInteraction: number; revision: number }>;
const blockers = new Map<symbol, string>();
const operations = new Map<symbol, string>();
const listeners = new Set<() => void>();
let lastInteraction = Date.now();
let revision = 0;
let gate: { token: string; expires: number; interactionRevision?: number } | undefined;
let gateTimer: ReturnType<typeof setTimeout> | undefined;
let snapshot: ReloadSafetyState;
const publish = () => {
  snapshot = Object.freeze({ reason: blockers.values().next().value ?? operations.values().next().value, operations: operations.size, gated: Boolean(gate), lastInteraction, revision });
  listeners.forEach((listener) => listener());
};
publish();
export const getReloadSafetyState = () => snapshot;
export const subscribeReloadSafety = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const releaseReloadGate = (token: string) => {
  if (gate?.token !== token) return false;
  gate = undefined;
  clearTimeout(gateTimer);
  gateTimer = undefined;
  publish();
  return true;
};
const invalidate = () => {
  revision += 1;
  if (gate) releaseReloadGate(gate.token);
  publish();
};
export const recordReloadInteraction = () => { lastInteraction = Date.now(); invalidate(); };
export const createReloadBlocker = (reason: string) => {
  const token = Symbol(reason);
  blockers.set(token, reason);
  invalidate();
  let released = false;
  return () => { if (released) return; released = true; blockers.delete(token); invalidate(); };
};
export class UpdatePreparingError extends Error {
  readonly code = 'UPDATE_PREPARING';
  constructor() { super('An app update is being prepared. Try again shortly.'); this.name = 'UpdatePreparingError'; }
}
/** Call before starting transport OR durable local work, not around a timeout wrapper. */
export const assertReloadOperationAllowed = () => {
  if (gate && Date.now() >= gate.expires) releaseReloadGate(gate.token);
  if (gate) throw new UpdatePreparingError();
};
export const beginProtectedOperation = (reason = 'Saving changes') => {
  assertReloadOperationAllowed();
  const token = Symbol(reason);
  operations.set(token, reason);
  invalidate();
  let released = false;
  return () => { if (released) return; released = true; operations.delete(token); invalidate(); };
};
/** The operation must return its full underlying promise, including late writes. */
export const runProtectedOperation = async <T>(operation: () => Promise<T>, reason?: string): Promise<T> => {
  const release = beginProtectedOperation(reason);
  try { return await operation(); } finally { release(); }
};
export const getReloadBlockReason = (now = Date.now()) => snapshot.reason ?? (now - lastInteraction < RELOAD_IDLE_MS ? 'Waiting for you to finish' : undefined);
export const isReloadSafe = () => !getReloadBlockReason();
/** Token ownership makes cancellation unable to release a newer attempt's gate. */
export const acquireReloadGate = (token: string, leaseMs: number, interactionRevision?: number) => {
  if (gate && Date.now() >= gate.expires) releaseReloadGate(gate.token);
  if (snapshot.reason || (interactionRevision === undefined ? !isReloadSafe() : interactionRevision !== revision) || (gate && gate.token !== token) || !Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > MAX_RELOAD_GATE_MS) return false;
  if (gate) return gate.token === token && Date.now() < gate.expires;
  gate = { token, expires: Date.now() + leaseMs, interactionRevision };
  gateTimer = setTimeout(() => releaseReloadGate(token), leaseMs);
  publish();
  return true;
};
export const ownsReloadGate = (token: string) => gate?.token === token && Date.now() < gate.expires && !snapshot.reason && (gate.interactionRevision === undefined ? isReloadSafe() : gate.interactionRevision === revision);

/** Capture phase runs before React handlers/effects and invalidates prepared ACKs. */
export const observeReloadInteractions = (target: Document) => {
  const events = ['pointerdown', 'keydown', 'input', 'change', 'submit', 'focusin'];
  events.forEach((event) => target.addEventListener(event, recordReloadInteraction, true));
  return () => events.forEach((event) => target.removeEventListener(event, recordReloadInteraction, true));
};
