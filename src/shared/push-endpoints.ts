/** Push service endpoints accepted by the notification delivery worker.
 * Keep this list exact: subscription endpoints are later used as outbound
 * fetch targets. */
const supportedServicePaths: Readonly<Record<string, readonly string[]>> = {
  'fcm.googleapis.com': ['/fcm/send/', '/wp/'],
  'updates.push.services.mozilla.com': ['/wpush/v2/'],
  'push.services.mozilla.com': ['/wpush/v2/'],
};

const isAppleWebPushPath = (pathname: string) => pathname.length > 1 && !pathname.slice(1).includes('/');

/** Return a canonical endpoint only when it is a supported HTTPS push service
 * URL. This is shared by request validation and stored-subscription reads. */
export const normalizeSupportedPushEndpoint = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return undefined;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'web.push.apple.com') {
      // Browser PushSubscription endpoints use one opaque path segment. The
      // APNs provider API's /3/device/ path is a different protocol and must
      // not be accepted as an outbound browser push target.
      if (!isAppleWebPushPath(url.pathname)) return undefined;
    } else {
      const paths = supportedServicePaths[hostname];
      if (!paths || !paths.some((prefix) => url.pathname.startsWith(prefix) && url.pathname.length > prefix.length)) return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
};

export const isSupportedPushEndpoint = (value: unknown): boolean => normalizeSupportedPushEndpoint(value) !== undefined;
