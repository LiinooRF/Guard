import { createHash, randomBytes } from 'node:crypto';

export type AuthActionPurpose = 'invitation' | 'password_reset';

export function createAuthActionToken(ttlMilliseconds: number) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashAuthActionToken(token),
    expiresAt: new Date(Date.now() + ttlMilliseconds),
  };
}

export function hashAuthActionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
