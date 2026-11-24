import { describe, expect, it } from 'vitest';
import { createNonce } from '../../src/nonce';

describe('createNonce', () => {
  it('is base64 text of 16 random bytes', () => {
    const nonce = createNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('is new every time', () => {
    const nonces = new Set(Array.from({ length: 100 }, () => createNonce()));
    expect(nonces.size).toBe(100);
  });
});
