import bcrypt from 'bcryptjs';

export function hashPassword(password: string, rounds: number): Promise<string> {
  return bcrypt.hash(password, rounds);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

let dummyHash: Promise<string> | undefined;

/**
 * A real hash to compare against when the email doesn't exist, so "unknown email"
 * and "wrong password" take the same time and can't be told apart.
 */
export function getDummyHash(rounds: number): Promise<string> {
  dummyHash ??= bcrypt.hash('monitorly-timing-equaliser', rounds);
  return dummyHash;
}
