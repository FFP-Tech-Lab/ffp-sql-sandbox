export const DEFAULT_SECRET_PATH: string;
export function readPassword(
  secretPath?: string,
  payload?: { password?: string },
): string;
