/**
 * Category learning uses SQLite's deliberately conservative case folding:
 * remove leading/trailing whitespace, then lowercase ASCII letters only.
 * SQLite's built-in lower() does not fold Unicode characters, so using
 * String#toLowerCase here would make migration keys differ from runtime keys.
 */
export const normalizeCategoryDescription = (description: string) => description.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
