import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OriginGuard } from './origin.guard';

type FakeRequest = {
  method: string;
  cookies?: Record<string, string>;
  headers: Record<string, string | undefined>;
  get: (name: string) => string | undefined;
};

function contextFor(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function request(
  method: string,
  headers: Record<string, string | undefined> = {},
  cookies: Record<string, string> = {},
): FakeRequest {
  const lower = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  return {
    method,
    cookies,
    headers,
    get: (name: string) => lower.get(name.toLowerCase()),
  };
}

describe('OriginGuard (CSRF)', () => {
  const config = {
    get: (key: string) => {
      if (key === 'WEB_ORIGIN') return 'http://localhost:3000';
      if (key === 'API_PUBLIC_ORIGIN') return 'http://localhost:3001';
      if (key === 'TENANT_DOMAIN') return 'mishef.co';
      return undefined;
    },
  } as unknown as ConfigService;

  const guard = new OriginGuard(config);

  it('deja pasar métodos seguros aunque haya cookies', () => {
    const req = request('GET', {}, { np_at: 'token' });
    expect(guard.canActivate(contextFor(req))).toBe(true);
  });

  it('deja pasar peticiones sin cookies (login, API pública)', () => {
    const req = request('POST', { origin: 'http://evil.example' });
    expect(guard.canActivate(contextFor(req))).toBe(true);
  });

  it('deja pasar peticiones con Bearer', () => {
    const req = request(
      'POST',
      { authorization: 'Bearer x' },
      { np_at: 'token' },
    );
    expect(guard.canActivate(contextFor(req))).toBe(true);
  });

  it('acepta el origen del frontend', () => {
    const req = request(
      'POST',
      { origin: 'http://localhost:3000' },
      { np_rt: 'token' },
    );
    expect(guard.canActivate(contextFor(req))).toBe(true);
  });

  it('acepta el subdominio de un negocio', () => {
    const req = request(
      'POST',
      { origin: 'https://demo.mishef.co' },
      { np_rt: 'token' },
    );
    expect(guard.canActivate(contextFor(req))).toBe(true);
  });

  it('acepta el Referer cuando no hay Origin', () => {
    const req = request(
      'POST',
      { referer: 'http://localhost:3000/dashboard' },
      { np_rt: 'token' },
    );
    expect(guard.canActivate(contextFor(req))).toBe(true);
  });

  it('rechaza un origen ajeno', () => {
    const req = request(
      'POST',
      { origin: 'http://evil.example' },
      { np_rt: 'token' },
    );
    expect(() => guard.canActivate(contextFor(req))).toThrow(
      ForbiddenException,
    );
  });

  it('rechaza cuando falta Origin y Referer', () => {
    const req = request('DELETE', {}, { np_at: 'token' });
    expect(() => guard.canActivate(contextFor(req))).toThrow(
      ForbiddenException,
    );
  });
});
