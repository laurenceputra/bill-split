export type ClerkAuthenticationConfig = {
  publishableKey?: string;
  secretKey?: string;
  jwtKey?: string;
  authorizedParties?: string;
};

type ClerkRequestState = {
  isAuthenticated?: boolean;
  status?: string;
  reason?: string | null;
  toAuth: () => {
    isAuthenticated?: boolean;
    userId?: string | null;
    sessionClaims?: Record<string, unknown> | null;
  } | null;
};

type AuthenticateRequest = (request: Request, options: { acceptsToken: 'session_token'; authorizedParties: string[] }) => Promise<ClerkRequestState>;

export class ClerkAuthenticationError extends Error {
  constructor(readonly code: 'AUTH_REQUIRED' | 'AUTH_INVALID', message: string) {
    super(message);
    this.name = 'ClerkAuthenticationError';
  }
}

export function parseAuthorizedParties(value: string | undefined): string[] {
  return (value ?? '').split(',').map((party) => party.trim()).filter(Boolean);
}

export function assertClerkAuthenticationConfig(config: ClerkAuthenticationConfig): void {
  if (!config.publishableKey || !config.secretKey || !config.jwtKey) throw new ClerkAuthenticationError('AUTH_REQUIRED', 'Clerk authentication configuration is missing');
  if (!parseAuthorizedParties(config.authorizedParties).length) throw new ClerkAuthenticationError('AUTH_REQUIRED', 'Clerk authorized parties configuration is missing');
}

/**
 * Keep the SDK boundary small and deterministic: the SDK verifies the
 * signature, token type, and azp allowlist, while this boundary verifies the
 * claims the application requires before touching D1.
 */
export async function authenticateClerkSession(request: Request, config: ClerkAuthenticationConfig, authenticateRequest: AuthenticateRequest) {
  assertClerkAuthenticationConfig(config);
  const authorizedParties = parseAuthorizedParties(config.authorizedParties);

  let state: ClerkRequestState;
  try {
    state = await authenticateRequest(request, { acceptsToken: 'session_token', authorizedParties });
  } catch {
    throw new ClerkAuthenticationError('AUTH_INVALID', 'The Clerk session could not be verified');
  }
  if (state.isAuthenticated !== true) throw new ClerkAuthenticationError(state.reason === 'session-token-missing' || state.reason === 'session-token-and-uat-missing' ? 'AUTH_REQUIRED' : 'AUTH_INVALID', 'A valid Clerk session is required');

  const auth = state.toAuth();
  const claims = auth?.sessionClaims ?? {};
  const clerkUserId = auth?.userId;
  const azp = claims.azp;
  const primaryEmail = claims.primaryEmail;
  const subject = claims.sub;
  if (!auth?.isAuthenticated || !clerkUserId || (typeof subject === 'string' && subject !== clerkUserId)) throw new ClerkAuthenticationError('AUTH_INVALID', 'The Clerk session has no stable user ID');
  if (typeof azp !== 'string' || !authorizedParties.includes(azp)) throw new ClerkAuthenticationError('AUTH_INVALID', 'The Clerk session came from an unauthorized party');
  if (typeof primaryEmail !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(primaryEmail.trim())) throw new ClerkAuthenticationError('AUTH_INVALID', 'The verified Clerk session has no usable primary email');
  return { clerkUserId, primaryEmail: primaryEmail.trim().toLowerCase(), authorizedParties };
}
