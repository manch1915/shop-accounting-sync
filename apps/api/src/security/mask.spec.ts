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

describe('mask inline colon pairs', () => {
  it('masks mid-line key: value pairs and JS-style objects', () => {
    const out = maskBody('error at step 2, client_secret: s3cr3tvalue99 {token: tk_abcdef1234}', null) ?? '';
    expect(out).not.toContain('s3cr3tvalue99');
    expect(out).not.toContain('tk_abcdef1234');
    expect(out).toContain('step 2');
  });
});

describe('mask values with delimiters inside', () => {
  it('masks the whole value up to whitespace even if it contains braces or quotes', () => {
    const out = maskBody("password=ab}cd'ef;gh123 next=1", null) ?? '';
    expect(out).not.toContain('gh123');
    expect(out).not.toContain('ab}cd');
  });
});

describe('mask does not let a harmless pair swallow a secret one', () => {
  it.each([
    ['foo=1;password=secret123', 'secret123'],
    ['"a":1;"token":"tok_998877"', 'tok_998877'],
    ['id: 7, api_key: key_556677', 'key_556677'],
    ['X-Request-Id: 1\nX-Auth Token: bearer_112233', 'bearer_112233'],
  ])('%s', (input, secret) => {
    expect(maskBody(input, null)).not.toContain(secret);
  });
});

describe('mask quoting and encoding variants', () => {
  it.each([
    ['"Authorization": Bearer abc.def.ghi', 'abc.def.ghi'],
    ['auth[token]: Bearer zz_998877', 'zz_998877'],
    ["{'Authorization': 'Bearer yy_665544'}", 'yy_665544'],
    ['password=\n  pw_334455', 'pw_334455'],
    ['client%5Fsecret=cs_112299&grant_type=x', 'cs_112299'],
    ['a=1&refresh_token=rt_776655&b=2', 'rt_776655'],
  ])('%s', (input, secret) => {
    expect(maskBody(input, null)).not.toContain(secret);
  });

  it('keeps harmless pairs before a secret readable', () => {
    expect(maskBody('grant_type=refresh_token&refresh_token=rt_1234567', null)).toBe(
      'grant_type=refresh_token&refresh_token=••••',
    );
  });
});
