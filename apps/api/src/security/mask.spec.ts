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

describe('mask hardening', () => {
  it('handles escaped quotes and bare values in broken JSON', () => {
    const out = maskBody('{"access_token": "ab\\"cdefghij", "api_key": 12345678, oops', null) ?? '';
    expect(out).not.toContain('cdefghij');
    expect(out).not.toContain('12345678');
  });

  it('masks header-style pairs', () => {
    expect(maskBody('Authorization: Bearer-abcdef123456\nX-Trace: 1', null)).not.toContain('abcdef123456');
  });

  it('stays fast on large hostile input', () => {
    const started = performance.now();
    maskBody(`${'a'.repeat(200_000)}=`, null);
    maskBody('token='.repeat(50_000), null);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('mask key coverage', () => {
  it('masks dotted, bracketed and spaced keys', () => {
    const out =
      maskBody('client.secret=abcdef123456 auth[token]=qwerty987654 {"api key": "zxcvbnm12345"', null) ?? '';
    expect(out).not.toContain('abcdef123456');
    expect(out).not.toContain('qwerty987654');
    expect(out).not.toContain('zxcvbnm12345');
  });

  it('masks the whole header value including the part after the scheme', () => {
    const out = maskBody('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload\nAccept: */*', null) ?? '';
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).toContain('Accept: */*');
  });
});
