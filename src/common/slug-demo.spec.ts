import { isResolvableTenantSlug, isValidSlug } from './slug';

describe('tenant slugs reservados para demo', () => {
  it('resuelve demo como tenant controlado', () => {
    expect(isResolvableTenantSlug('demo')).toBe(true);
  });

  it('mantiene demo reservado para altas normales', () => {
    expect(isValidSlug('demo')).toBe(false);
  });

  it('no resuelve otros slugs reservados', () => {
    expect(isResolvableTenantSlug('api')).toBe(false);
    expect(isResolvableTenantSlug('app')).toBe(false);
  });

  it('resuelve slugs normales', () => {
    expect(isResolvableTenantSlug('mi-cafeteria')).toBe(true);
  });
});
