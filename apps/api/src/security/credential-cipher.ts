import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;

/**
 * AES-256-GCM for provider tokens at rest. Output: v1.<iv>.<tag>.<ciphertext>, base64url parts.
 * The version prefix leaves room for key rotation without a data migration.
 */
export class CredentialCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes encoded as base64');
    }
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, tag, data]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split('.');
    if (version !== VERSION || !iv || !tag || !data) {
      throw new Error('Unsupported credential payload');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString(
      'utf8',
    );
  }

  encryptJson(value: Record<string, string>): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson(payload: string): Record<string, string> {
    return JSON.parse(this.decrypt(payload)) as Record<string, string>;
  }
}
