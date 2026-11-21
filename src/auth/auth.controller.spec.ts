import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import type { AuthService, GoogleLinkResult, GoogleLoginResult } from './auth.service';
import type { GoogleOauthService } from './google-oauth.service';
import type { TurnstileService } from '../common/turnstile.service';

function responseMock() {
  return {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
  };
}

function requestMock(cookies: Record<string, string> = {}): Request {
  return {
    cookies,
    ip: '127.0.0.1',
    get: () => 'jest-agent',
  } as unknown as Request;
}

const config = {
  get: (key: string) => {
    if (key === 'WEB_ORIGIN') return 'http://localhost:3000';
    if (key === 'NODE_ENV') return 'test';
    return undefined;
  },
} as unknown as ConfigService;

const profile = {
  sub: 'google-sub',
  email: 'admin@naranjapimienta.local',
  emailVerified: true,
  name: 'Admin',
};

function createController(options: {
  configured?: boolean;
  result?: GoogleLoginResult;
  linkUserId?: string | null;
  linkResult?: GoogleLinkResult;
}) {
  const auth = {
    loginWithGoogle: jest
      .fn()
      .mockResolvedValue(options.result ?? { kind: 'session' }),
    userIdFromAccessToken: jest
      .fn()
      .mockResolvedValue(
        options.linkUserId === undefined ? 'user-1' : options.linkUserId,
      ),
    linkGoogleAccount: jest
      .fn()
      .mockResolvedValue(options.linkResult ?? { ok: true }),
    issueSessionForUser: jest.fn(),
  } as unknown as AuthService;

  const google = {
    isConfigured: options.configured ?? true,
    createChallenge: () => ({
      state: 'state-123',
      verifier: 'verifier-456',
      challenge: 'challenge-789',
    }),
    authorizationUrl: jest.fn(
      () => 'https://accounts.google.com/o/oauth2/v2/auth?state=state-123',
    ),
    fetchProfile: jest.fn().mockResolvedValue(profile),
    redirectUri: () => 'http://localhost:3001/v1/auth/google/callback',
  } as unknown as GoogleOauthService;

  const turnstile = {
    enabled: false,
    verify: jest.fn().mockResolvedValue(true),
  } as unknown as TurnstileService;

  return {
    controller: new AuthController(auth, google, config, turnstile),
    auth,
    google,
    turnstile,
  };
}

describe('AuthController — Google OAuth', () => {
  it('responde 503 si Google no está configurado', () => {
    const { controller } = createController({ configured: false });

    expect(() => controller.startGoogleLogin(responseMock() as unknown as Response)).toThrow(
      ServiceUnavailableException,
    );
  });

  it('redirige a Google y guarda state + verificador PKCE en cookies', () => {
    const { controller } = createController({});
    const res = responseMock();

    controller.startGoogleLogin(res as unknown as Response);

    expect(res.cookie).toHaveBeenCalledWith(
      'np_oauth_state',
      'state-123',
      expect.objectContaining({ httpOnly: true, path: '/v1/auth/google' }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'np_oauth_verifier',
      'verifier-456',
      expect.objectContaining({ httpOnly: true, path: '/v1/auth/google' }),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?state=state-123',
    );
  });

  it('rechaza el callback si el state no coincide', async () => {
    const { controller } = createController({});
    const res = responseMock();

    await controller.googleCallback(
      requestMock({
        np_oauth_state: 'otro-state',
        np_oauth_verifier: 'verifier-456',
      }),
      res as unknown as Response,
      'code',
      'state-123',
    );

    expect(res.redirect).toHaveBeenCalledWith(
      'http://localhost:3000/login?error=google_state',
    );
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('redirige al dashboard con cookies cuando el login es correcto', async () => {
    const { controller } = createController({
      result: {
        kind: 'session',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: {
          id: 'user-1',
          email: profile.email,
          name: 'Admin',
          roles: ['ADMIN' as never],
          organizationId: 'org-1',
          organizationName: 'Naranja Pimienta',
        },
      },
    });
    const res = responseMock();

    await controller.googleCallback(
      requestMock({
        np_oauth_state: 'state-123',
        np_oauth_verifier: 'verifier-456',
      }),
      res as unknown as Response,
      'code',
      'state-123',
    );

    expect(res.cookie).toHaveBeenCalledWith(
      'np_at',
      'access-token',
      expect.objectContaining({ httpOnly: true }),
    );
    expect(res.redirect).toHaveBeenCalledWith('http://localhost:3000/dashboard');
  });

  it('pide el segundo factor cuando la cuenta tiene 2FA', async () => {
    const { controller } = createController({
      result: {
        kind: 'twofactor',
        challengeId: 'challenge-1',
        email: profile.email,
      },
    });
    const res = responseMock();

    await controller.googleCallback(
      requestMock({
        np_oauth_state: 'state-123',
        np_oauth_verifier: 'verifier-456',
      }),
      res as unknown as Response,
      'code',
      'state-123',
    );

    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'http://localhost:3000/login?twoFactor=1&challengeId=challenge-1&email=admin%40naranjapimienta.local&method=EMAIL',
    );
  });

  it('redirige con error cuando la cuenta no existe', async () => {
    const { controller } = createController({
      result: { kind: 'error', reason: 'no_account' },
    });
    const res = responseMock();

    await controller.googleCallback(
      requestMock({
        np_oauth_state: 'state-123',
        np_oauth_verifier: 'verifier-456',
      }),
      res as unknown as Response,
      'code',
      'state-123',
    );

    expect(res.redirect).toHaveBeenCalledWith(
      'http://localhost:3000/login?error=google_no_account',
    );
  });

  it('redirige con error si el usuario cancela en Google', async () => {
    const { controller } = createController({});
    const res = responseMock();

    await controller.googleCallback(
      requestMock(),
      res as unknown as Response,
      undefined,
      undefined,
      'access_denied',
    );

    expect(res.redirect).toHaveBeenCalledWith(
      'http://localhost:3000/login?error=google_cancelled',
    );
  });

  it('redirige con error si Google no valida el código', async () => {
    const { controller, google } = createController({});
    (google.fetchProfile as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = responseMock();

    await controller.googleCallback(
      requestMock({
        np_oauth_state: 'state-123',
        np_oauth_verifier: 'verifier-456',
      }),
      res as unknown as Response,
      'code',
      'state-123',
    );

    expect(res.redirect).toHaveBeenCalledWith(
      'http://localhost:3000/login?error=google_failed',
    );
  });

  it('inicia la vinculación de Google marcando el flujo con cookie', () => {
    const { controller } = createController({});
    const res = responseMock();

    controller.startGoogleLink(res as unknown as Response);

    expect(res.cookie).toHaveBeenCalledWith(
      'np_oauth_link',
      '1',
      expect.objectContaining({ httpOnly: true, path: '/v1/auth/google' }),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?state=state-123',
    );
  });

  it('rechaza iniciar la vinculación si Google no está configurado', () => {
    const { controller } = createController({ configured: false });

    expect(() =>
      controller.startGoogleLink(responseMock() as unknown as Response),
    ).toThrow(ServiceUnavailableException);
  });

  it('vincula la cuenta y vuelve a Ajustes', async () => {
    const { controller, auth } = createController({
      linkResult: { ok: true },
    });
    const res = responseMock();

    await controller.googleCallback(
      requestMock({
        np_oauth_state: 'state-123',
        np_oauth_verifier: 'verifier-456',
        np_oauth_link: '1',
        np_at: 'access-token',
      }),
      res as unknown as Response,
      'code',
      'state-123',
    );

    expect(auth.userIdFromAccessToken).toHaveBeenCalledWith('access-token');
    expect(auth.linkGoogleAccount).toHaveBeenCalledWith('user-1', profile);
    expect(auth.loginWithGoogle).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalledWith(
      'np_at',
      expect.anything(),
      expect.anything(),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'http://localhost:3000/settings?google=linked',
    );
  });

  it('informa el motivo cuando no se puede vincular', async () => {
    const { controller } = createController({
      linkResult: { ok: false, reason: 'already_linked' },
    });
    const res = responseMock();

    await controller.googleCallback(
      requestMock({
        np_oauth_state: 'state-123',
        np_oauth_verifier: 'verifier-456',
        np_oauth_link: '1',
        np_at: 'access-token',
      }),
      res as unknown as Response,
      'code',
      'state-123',
    );

    expect(res.redirect).toHaveBeenCalledWith(
      'http://localhost:3000/settings?google=error_already_linked',
    );
  });

  it('no vincula si la sesión ya no es válida', async () => {
    const { controller, auth } = createController({ linkUserId: null });
    const res = responseMock();

    await controller.googleCallback(
      requestMock({
        np_oauth_state: 'state-123',
        np_oauth_verifier: 'verifier-456',
        np_oauth_link: '1',
      }),
      res as unknown as Response,
      'code',
      'state-123',
    );

    expect(auth.linkGoogleAccount).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'http://localhost:3000/settings?google=google_link_session',
    );
  });
});
