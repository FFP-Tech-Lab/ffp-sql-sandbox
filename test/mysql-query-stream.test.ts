import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { createStreamLimiter } from '../sandbox/stream-limit.js';
import {
  closeMysqlConnection,
  runMysqlQuery,
} from '../sandbox/mysql-query-stream.js';
import { isQueryTimeoutError } from '../sandbox/query-watchdog.js';

type Field = { name: string };

class MysqlShapedQuery extends EventEmitter {}

function collectEvents(): {
  events: Array<Record<string, unknown>>;
  writeEvent: (event: { type: string; [key: string]: unknown }) => void;
} {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    writeEvent(event) {
      events.push({ ...event });
    },
  };
}

describe('MySQL query stream timeout (SLEEP analog)', () => {
  it('destroys the connection within timeoutMs when the query never returns', async () => {
    const query = new MysqlShapedQuery();
    let destroyed = 0;
    const connection = {
      query() {
        return query;
      },
      destroy() {
        destroyed += 1;
        queueMicrotask(() => {
          query.emit('error', new Error('Connection lost'));
        });
      },
    };
    const conn = { connection };
    const { events, writeEvent } = collectEvents();
    const started = Date.now();

    await assert.rejects(
      () =>
        runMysqlQuery(
          conn,
          'SELECT SLEEP(15)',
          50,
          createStreamLimiter({ maxRows: 100, maxBytes: 1_000_000 }),
          writeEvent,
        ),
      (err: unknown) => {
        assert.equal(isQueryTimeoutError(err), true);
        return true;
      },
    );

    const elapsed = Date.now() - started;
    assert.ok(destroyed >= 1, 'expected connection.destroy() on QUERY_TIMEOUT');
    assert.ok(elapsed < 400, `MySQL SLEEP analog hung ${elapsed}ms`);
    assert.equal(
      events.some((event) => event.type === 'end' && event.truncated !== true),
      false,
      'timeout must not emit a successful end event',
    );
  });

  it('emits truncated and does not wait on hung conn.end() after maxRows', async () => {
    const query = new MysqlShapedQuery();
    const connection = {
      query() {
        queueMicrotask(() => {
          query.emit('fields', [{ name: 'n' } satisfies Field]);
          for (let i = 0; i < 10; i += 1) {
            query.emit('result', [i]);
          }
          query.emit('end');
        });
        return query;
      },
      destroy() {
        /* socket dropped */
      },
    };
    const { events, writeEvent } = collectEvents();
    await runMysqlQuery(
      { connection },
      'SELECT n FROM t',
      5_000,
      createStreamLimiter({ maxRows: 2, maxBytes: 1_000_000 }),
      writeEvent,
    );
    assert.equal(events.some((event) => event.type === 'end' && event.truncated === true), true);
    assert.ok(events.filter((event) => event.type === 'row').length <= 2);

    let ended = false;
    const hanging = {
      connection,
      end() {
        return new Promise<void>(() => {
          /* hang like mysql2 after destroy() */
        });
      },
      destroy() {
        ended = true;
      },
    };
    const started = Date.now();
    await closeMysqlConnection(hanging);
    const elapsed = Date.now() - started;
    assert.equal(ended, true);
    assert.ok(elapsed < 500, `closeMysqlConnection hung ${elapsed}ms`);
  });
});
