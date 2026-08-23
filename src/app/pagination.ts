/** Append a keyset page without duplicating rows returned by a refresh. */
export function appendUniquePage<T>(current: T[], page: T[], key: (item: T) => string): T[] {
  const seen = new Set(current.map(key));
  return [...current, ...page.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  })];
}

export type PageRequest = {
  key: string;
  cursor: string;
  signal: AbortSignal;
  token: number;
};

/**
 * Owns the identity of a continuation request. A route/filter change, a
 * refresh, or a newer request invalidates the old cursor and aborts its
 * transport where the API supports it.
 */
export function createPageRequestScope() {
  let key = '';
  let token = 0;
  let controller: AbortController | undefined;

  const reset = (nextKey: string) => {
    controller?.abort();
    controller = undefined;
    key = nextKey;
    token += 1;
  };

  return {
    reset,
    begin(nextKey: string, cursor: string): PageRequest {
      if (key !== nextKey) reset(nextKey);
      controller?.abort();
      const nextController = new AbortController();
      controller = nextController;
      const request = { key: nextKey, cursor, signal: nextController.signal, token: ++token };
      return request;
    },
    isCurrent(request: PageRequest) {
      return request.key === key && request.token === token && !request.signal.aborted;
    },
    dispose() {
      controller?.abort();
      controller = undefined;
      token += 1;
    },
  };
}
