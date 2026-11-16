import {
  buildOrganizationSlug,
  isValidSlug,
  normalizeSlug,
} from './slug';

describe('slug de organización', () => {
  it('normaliza acentos, mayúsculas, espacios y símbolos', () => {
    expect(normalizeSlug('  Café  Central!! ')).toBe('cafe-central');
    expect(normalizeSlug('ÑOÑO’s Bar')).toBe('nono-s-bar');
  });

  it('recorta a la longitud máxima', () => {
    expect(normalizeSlug('a'.repeat(80)).length).toBe(32);
  });

  it('rechaza direcciones reservadas', () => {
    for (const reserved of ['api', 'app', 'www', 'admin', 'dokploy']) {
      expect(isValidSlug(reserved)).toBe(false);
    }
  });

  it('rechaza guiones en los bordes y consecutivos', () => {
    expect(isValidSlug('-cafe')).toBe(false);
    expect(isValidSlug('cafe-')).toBe(false);
    expect(isValidSlug('cafe--central')).toBe(false);
  });

  it('rechaza direcciones demasiado cortas', () => {
    expect(isValidSlug('ab')).toBe(false);
  });

  it('acepta direcciones normales', () => {
    expect(isValidSlug('mi-cafeteria')).toBe(true);
    expect(isValidSlug('cafe2')).toBe(true);
  });

  it('genera un slug con sufijo aleatorio de 6 hexadecimales', () => {
    expect(buildOrganizationSlug('Café Central')).toMatch(
      /^cafe-central-[0-9a-f]{6}$/,
    );
  });
});
