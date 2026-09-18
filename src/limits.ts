import {
  DEFAULT_SANDBOX_LIMITS,
  type SandboxLimits,
} from './types.js';

export type LimitsError = { ok: false; error: string };
export type LimitsOk = { ok: true; limits: SandboxLimits };

const LIMIT_KEYS = [
  'timeoutMs',
  'memoryMb',
  'nanoCpus',
  'maxRows',
  'maxBytes',
] as const;

export function mergeLimits(
  partial?: Partial<SandboxLimits>,
): LimitsOk | LimitsError {
  const limits: SandboxLimits = {
    ...DEFAULT_SANDBOX_LIMITS,
    ...partial,
  };

  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    if (!Number.isInteger(value) || value <= 0) {
      return {
        ok: false,
        error: `${key} must be a positive integer`,
      };
    }
  }

  return { ok: true, limits };
}
