import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as api from '../src/index.js';
import {
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_LIMITS,
  executeSql,
  validateSql,
} from '../src/index.js';

describe('public API surface', () => {
  it('does not export resolveSandboxDbHost', () => {
    assert.equal('resolveSandboxDbHost' in api, false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(api, 'resolveSandboxDbHost'),
      false,
    );
  });

  it('exports validateSql, executeSql, default limits, and a digest-pinned image', () => {
    assert.equal(typeof validateSql, 'function');
    assert.equal(typeof executeSql, 'function');
    assert.equal(DEFAULT_SANDBOX_LIMITS.timeoutMs, 10_000);
    assert.equal(DEFAULT_SANDBOX_LIMITS.memoryMb, 128);
    assert.equal(DEFAULT_SANDBOX_LIMITS.nanoCpus, 500_000_000);
    assert.equal(DEFAULT_SANDBOX_LIMITS.maxRows, 1_000);
    assert.equal(DEFAULT_SANDBOX_LIMITS.maxBytes, 1_000_000);
    assert.match(
      DEFAULT_SANDBOX_IMAGE,
      /^ghcr\.io\/ffp-tech-lab\/ffp-sql-sandbox-runner@sha256:[a-f0-9]{64}$/,
    );
  });

  it('does not export validator pattern configuration hooks', () => {
    assert.equal('ALLOWED_PREFIX' in api, false);
    assert.equal('FORBIDDEN_PATTERNS' in api, false);
    assert.equal('allowPrefixes' in api, false);
    assert.equal('forbidPatterns' in api, false);
  });
});
