import { readFileSync } from 'node:fs';

export const DEFAULT_SECRET_PATH = '/run/secrets/db_password';

/** Official runner reads the tmpfs secret only. No stdin/payload password fallback. */
export function readPassword(secretPath = DEFAULT_SECRET_PATH) {
  try {
    return readFileSync(secretPath, 'utf8');
  } catch {
    throw new Error('Database password missing (expected tmpfs secret file)');
  }
}
