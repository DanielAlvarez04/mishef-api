import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Cifra en reposo los tokens de Mercado Pago con AES-256-GCM.
 *
 * Formato: `v1:{iv}:{authTag}:{ciphertext}` en base64. La clave vive en
 * `MP_TOKEN_ENCRYPTION_KEY` (32 bytes en base64); si falta, la API arranca pero
 * cualquier operación de MP falla de forma explícita.
 */
@Injectable()
export class TokenCipher {
  constructor(private readonly config: ConfigService) {}

  encrypt(plain: string): string {
    const key = this.key();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plain, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      VERSION,
      iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const [version, ivB64, authTagB64, ciphertextB64] = payload.split(':');

    if (
      version !== VERSION ||
      !ivB64 ||
      !authTagB64 ||
      !ciphertextB64
    ) {
      throw new InternalServerErrorException(
        'El token almacenado de Mercado Pago no tiene un formato válido',
      );
    }

    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        this.key(),
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new InternalServerErrorException(
        'No se pudo descifrar el token de Mercado Pago. Revisa MP_TOKEN_ENCRYPTION_KEY',
      );
    }
  }

  private key(): Buffer {
    const raw = this.config.get<string>('MP_TOKEN_ENCRYPTION_KEY') ?? '';
    const key = Buffer.from(raw, 'base64');

    if (!raw || key.length !== KEY_BYTES) {
      throw new InternalServerErrorException(
        'MP_TOKEN_ENCRYPTION_KEY debe ser una clave base64 de 32 bytes',
      );
    }

    return key;
  }
}
