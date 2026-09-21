import { readFileSync } from 'node:fs';

export const DEFAULT_SECRET_PATH = '/run/secrets/db_password';

/** Official runner reads the bind-mounted secret file only. No stdin/payload password fallback. */
export function readPassword(
  secretPath = DEFAULT_SECRET_PATH,
  payload,
) {
  void payload;
  try {
    return readFileSync(secretPath, 'utf8');
  } catch {
    throw new Error(
      'Database password missing (expected bind-mounted secret at /run/secrets/db_password)',
    );
  }
}
