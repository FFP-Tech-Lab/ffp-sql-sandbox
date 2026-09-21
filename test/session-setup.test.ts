import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sessionSetupStatements } from '../sandbox/session-setup.js';

describe('runner session setup (read-only + statement_timeout)', () => {
  it('sets postgres read-only characteristics and statement_timeout from timeoutMs', () => {
    const statements = sessionSetupStatements('postgres', 10_000);
    assert.deepEqual(statements, [
      'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY',
      'SET statement_timeout = 10000',
    ]);
  });

  it('sets mysql read-only transaction and MAX_EXECUTION_TIME from timeoutMs', () => {
    const statements = sessionSetupStatements('mysql', 2500);
    assert.deepEqual(statements, [
      'SET SESSION TRANSACTION READ ONLY',
      'SET SESSION MAX_EXECUTION_TIME = 2500',
    ]);
    // MAX_EXECUTION_TIME does not abort SLEEP(); runner watchdog does. See README.
  });

  it('rejects non-integer timeouts so they cannot be interpolated into SQL', () => {
    assert.throws(() => sessionSetupStatements('postgres', 10.5), /integer/);
    assert.throws(() => sessionSetupStatements('mysql', -1), /integer/);
  });
});
