export function sortOptionsByLabel<T>(
  values: readonly T[],
  getLabel: (value: T) => string,
  getTieBreaker: (value: T) => string = getLabel,
): T[] {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return [...values].sort((left, right) => {
    const labelOrder = collator.compare(getLabel(left), getLabel(right));
    if (labelOrder) return labelOrder;
    const leftKey = getTieBreaker(left);
    const rightKey = getTieBreaker(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}
