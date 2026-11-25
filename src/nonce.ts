import { randomBytes } from 'node:crypto';

/** A new random nonce for the content security policy of one page. */
export function createNonce(): string {
  return randomBytes(16).toString('base64');
}
