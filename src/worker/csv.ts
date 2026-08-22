/** Escape one CSV cell and neutralize spreadsheet formula prefixes. */
export function escapeCsvCell(value: unknown): string {
  const valueText = String(value ?? '');
  // Spreadsheet applications commonly ignore leading whitespace before
  // deciding whether a cell is a formula. Preserve the value, but prefix an
  // apostrophe whenever its first non-whitespace character is dangerous.
  const safe = /^[=+\-@]/.test(valueText.trimStart()) ? `'${valueText}` : valueText;
  return `"${safe.replaceAll('"', '""')}"`;
}
