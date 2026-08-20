import { describe, expect, it } from 'vitest';
import { isIOS, isStandalone } from './install';

describe('install helpers', () => {
  it('are safe when browser display APIs are unavailable', () => {
    expect(isStandalone()).toBe(false);
    expect(isIOS()).toBe(false);
  });
});
