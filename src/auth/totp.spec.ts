import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpAt,
  totpUri,
  verifyTotp,
} from './totp';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('TOTP', () => {
  it('codifica y decodifica base32', () => {
    const value = Buffer.from('12345678901234567890');
    expect(base32Encode(value)).toBe(RFC_SECRET);
    expect(base32Decode(RFC_SECRET).toString()).toBe(
      '12345678901234567890',
    );
  });

  it('genera el código del vector RFC 6238', () => {
    expect(totpAt(RFC_SECRET, 59_000)).toBe('287082');
  });

  it('acepta el código actual y rechaza uno incorrecto', () => {
    const timestamp = 59_000;
    const code = totpAt(RFC_SECRET, timestamp);

    expect(verifyTotp(RFC_SECRET, code, timestamp)).toBe(true);
    expect(verifyTotp(RFC_SECRET, '000000', timestamp)).toBe(false);
  });

  it('tolera un paso de desfase', () => {
    const timestamp = 90_000;
    const previous = totpAt(RFC_SECRET, timestamp - 30_000);

    expect(verifyTotp(RFC_SECRET, previous, timestamp)).toBe(true);
  });

  it('genera secretos base32 válidos y una URI otpauth', () => {
    const secret = generateTotpSecret();

    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(secret).length).toBe(20);
    expect(totpUri(secret, 'ana@cafe.com')).toContain(
      'otpauth://totp/Mishef%3Aana%40cafe.com',
    );
  });
});
