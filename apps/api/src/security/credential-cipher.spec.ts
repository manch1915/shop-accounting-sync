import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialCipher } from './credential-cipher.js';

const key = randomBytes(32).toString('base64');

describe('CredentialCipher', () => {
  it('round-trips JSON credentials', () => {
    const cipher = new CredentialCipher(key);
    const payload = cipher.encryptJson({ token: 'secret-token' });
    expect(payload.startsWith('v1.')).toBe(true);
    expect(payload).not.toContain('secret-token');
    expect(cipher.decryptJson(payload)).toEqual({ token: 'secret-token' });
  });

  it('uses a fresh IV every time', () => {
    const cipher = new CredentialCipher(key);
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('refuses tampered ciphertext', () => {
    const cipher = new CredentialCipher(key);
    const [v, iv, tag, data] = cipher.encrypt('value').split('.');
    const flipped = Buffer.from(data ?? '', 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => cipher.decrypt([v, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });

  it('rejects keys of the wrong size', () => {
    expect(() => new CredentialCipher(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
