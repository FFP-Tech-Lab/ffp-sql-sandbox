import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { streamPgQuery } from '../sandbox/pg-query-stream.js';
import { createStreamLimiter } from '../sandbox/stream-limit.js';

type Field = { name: string };

/** node-postgres 8.x Query shape: no `fields` event. */
class PostgresShapedQuery extends EventEmitter {}

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

function clientThatRuns(
  queryEvents: (query: PostgresShapedQuery) => void,
): {
  query: (query: PostgresShapedQuery) => void;
  connection: { stream: { destroy: () => void } };
  destroyed: boolean;
} {
  const state = {
    destroyed: false,
    query(query: PostgresShapedQuery) {
      queueMicrotask(() => {
        queryEvents(query);
      });
    },
    connection: {
      stream: {
        destroy() {
          state.destroyed = true;
        },
      },
    },
  };
  return state;
}

describe('Postgres query stream meta columns (pg 8.x result.fields)', () => {
  it('emits meta from result.fields on row when Query never fires fields', async () => {
    const query = new PostgresShapedQuery();
    const { events, writeEvent } = collectEvents();
    const fields: Field[] = [
      { name: 'order_date' },
      { name: 'daily_total' },
    ];
    const result = { fields };
    const client = clientThatRuns((q) => {
      q.emit('row', ['2026-08-22T00:00:00.000Z', '103387.00'], result);
      q.emit('row', ['2026-08-23T00:00:00.000Z', '99100.00'], result);
      q.emit('end', result);
    });

    await streamPgQuery(
      query,
      client,
      createStreamLimiter({ maxRows: 100, maxBytes: 1_000_000 }),
      writeEvent,
    );

    const meta = events.find((event) => event.type === 'meta');
    assert.ok(meta, 'expected a meta event; pg 8.x only provides result.fields');
    assert.deepEqual(meta.columns, ['order_date', 'daily_total']);
    assert.equal(events[0]?.type, 'meta');
    assert.deepEqual(events[1], {
      type: 'row',
      values: ['2026-08-22T00:00:00.000Z', '103387.00'],
    });
    assert.deepEqual(events.at(-1), { type: 'end', truncated: false });
  });

  it('emits meta from result.fields on end for a zero-row result with a schema', async () => {
    const query = new PostgresShapedQuery();
    const { events, writeEvent } = collectEvents();
    const result = { fields: [{ name: 'id' }, { name: 'email' }] };
    const client = clientThatRuns((q) => {
      q.emit('end', result);
    });

    await streamPgQuery(
      query,
      client,
      createStreamLimiter({ maxRows: 100, maxBytes: 1_000_000 }),
      writeEvent,
    );

    assert.deepEqual(events, [
      { type: 'meta', columns: ['id', 'email'] },
      { type: 'end', truncated: false },
    ]);
  });

  it('emits meta only once when both row and end carry result.fields', async () => {
    const query = new PostgresShapedQuery();
    const { events, writeEvent } = collectEvents();
    const result = { fields: [{ name: 'n' }] };
    const client = clientThatRuns((q) => {
      q.emit('row', [1], result);
      q.emit('end', result);
    });

    await streamPgQuery(
      query,
      client,
      createStreamLimiter({ maxRows: 100, maxBytes: 1_000_000 }),
      writeEvent,
    );

    const metas = events.filter((event) => event.type === 'meta');
    assert.equal(metas.length, 1);
    assert.deepEqual(metas[0]?.columns, ['n']);
  });

  it('still emits meta once if a Query also fires the legacy fields event', async () => {
    const query = new PostgresShapedQuery();
    const { events, writeEvent } = collectEvents();
    const fields: Field[] = [{ name: 'x' }];
    const result = { fields };
    const client = clientThatRuns((q) => {
      q.emit('fields', fields);
      q.emit('row', [1], result);
      q.emit('end', result);
    });

    await streamPgQuery(
      query,
      client,
      createStreamLimiter({ maxRows: 100, maxBytes: 1_000_000 }),
      writeEvent,
    );

    const metas = events.filter((event) => event.type === 'meta');
    assert.equal(metas.length, 1);
    assert.deepEqual(metas[0]?.columns, ['x']);
  });
});

describe('MySQL path is unchanged', () => {
  it('still emits meta from the mysql2 fields event in execute.js', () => {
    const src = readFileSync(new URL('../sandbox/execute.js', import.meta.url), 'utf8');
    assert.match(src, /streamPgQuery\(/);
    const mysqlFn = src.slice(src.indexOf('function streamMysql'));
    assert.match(mysqlFn, /query\.on\(\s*['"]fields['"]/);
    assert.doesNotMatch(mysqlFn, /result\.fields/);
  });
});
