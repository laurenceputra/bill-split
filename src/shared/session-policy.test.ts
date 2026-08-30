import { describe, expect, it } from 'vitest';
import { APPLICATION_SESSION_ACTIVITY_THROTTLE_MS, APPLICATION_SESSION_IDLE_MS } from './session-policy';

describe('application session policy', () => {
  it('uses a 30-day idle timeout and 24-hour activity throttle', () => {
    expect(APPLICATION_SESSION_IDLE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(APPLICATION_SESSION_ACTIVITY_THROTTLE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
