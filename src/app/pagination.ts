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
