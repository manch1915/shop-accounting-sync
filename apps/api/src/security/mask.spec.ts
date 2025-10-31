import { describe, expect, it } from 'vitest';
import { maskBody, maskHeaders, maskUrl } from './mask.js';

describe('mask', () => {
  it('hides auth headers but keeps the scheme and last chars', () => {
    const out = maskHeaders({ Authorization: 'Bearer abcdef1234567890', 'content-type': 'application/json' });
    expect(out.Authorization).toBe('Bearer ••••7890');
    expect(out['content-type']).toBe('application/json');
  });

  it('hides WooCommerce keys passed in the query string', () => {
    const out = maskUrl('https://shop.test/wp-json/wc/v3/orders?consumer_key=ck_123456789&per_page=50');
    expect(out).toContain('per_page=50');
    expect(out).not.toContain('ck_123456789');
  });

  it('walks nested JSON and masks token fields only', () => {
    const body = JSON.stringify({
      refresh_token: 'rt_very_secret_value',
      tenant: { name: 'Hillside', apiKey: 'k' },
    });
    const out = maskBody(body, 'application/json') ?? '';
    expect(out).not.toContain('rt_very_secret_value');
    expect(out).toContain('Hillside');
    expect(out).not.toContain('"k"');
  });

  it('masks the OAuth code in form bodies but leaves postcode alone', () => {
    const out = maskBody(
      'grant_type=authorization_code&code=abc123&postcode=SW1A',
      'application/x-www-form-urlencoded',
    );
    expect(out).toContain('postcode=SW1A');
    expect(out).not.toContain('abc123');
  });

  it('truncates huge bodies', () => {
    const out = maskBody('x'.repeat(20_000), 'text/plain') ?? '';
    expect(out.length).toBeLessThan(17_000);
    expect(out).toContain('truncated');
  });
});

describe('mask without a trustworthy content type', () => {
  it('parses JSON sent as text/plain', () => {
    expect(maskBody('{"access_token":"abcdefghijkl"}', 'text/plain')).not.toContain('abcdefghijkl');
  });

  it('parses form bodies without a header', () => {
    expect(maskBody('refresh_token=rt_123456789&grant_type=refresh_token', null)).not.toContain(
      'rt_123456789',
    );
  });

  it('redacts key/value pairs inside broken JSON or HTML', () => {
    const out = maskBody(
      '<p>error "client_secret": "s3cr3t-value", token=abc12345 status=500</p>',
      'text/html',
    );
    expect(out).not.toContain('s3cr3t-value');
    expect(out).not.toContain('abc12345');
    expect(out).toContain('status=500');
  });
});
