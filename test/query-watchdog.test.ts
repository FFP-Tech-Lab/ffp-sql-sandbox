import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isQueryTimeoutError,
  queryTimeoutError,
  startQueryWatchdog,
} from '../sandbox/query-watchdog.js';

describe('query watchdog (runner wall-clock timeout)', () => {
  it('fires at timeoutMs so SLEEP-like waits cannot outlive QUERY_TIMEOUT', async () => {
    const started = Date.now();
    const err = await new Promise<unknown>((resolve) => {
      startQueryWatchdog(40, resolve);
    });
    const elapsed = Date.now() - started;
    assert.equal(isQueryTimeoutError(err), true);
    assert.match(String((err as Error).message), /QUERY_TIMEOUT/);
    assert.ok(elapsed >= 25, `watchdog fired too early (${elapsed}ms)`);
    assert.ok(elapsed < 250, `watchdog fired too late (${elapsed}ms)`);
  });

  it('does not fire after clear()', async () => {
    let fired = false;
    const clear = startQueryWatchdog(30, () => {
      fired = true;
    });
    clear();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(fired, false);
  });

  it('recognizes Postgres statement_timeout and MySQL interrupt messages', () => {
    assert.equal(isQueryTimeoutError(queryTimeoutError(10_000)), true);
    assert.equal(
      isQueryTimeoutError(
        new Error('canceling statement due to statement timeout'),
      ),
      true,
    );
    assert.equal(
      isQueryTimeoutError(new Error('Query execution was interrupted')),
      true,
    );
    assert.equal(isQueryTimeoutError(new Error('relation t does not exist')), false);
  });
});
