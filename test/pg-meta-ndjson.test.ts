import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { encodeRunnerEvent } from '../sandbox/events.js';
import { streamPgQuery } from '../sandbox/pg-query-stream.js';
import { createStreamLimiter } from '../sandbox/stream-limit.js';
import { consumeNdjsonResult } from '../src/stream-consumer.js';

/**
 * pg 8.x FieldDef subset. The runner must read `name` from `result.fields`,
 * not from a `fields` Query event (node-postgres 8 never emits that event).
 */
type PgFieldDef = {
  name: string;
  tableID: number;
  columnID: number;
  dataTypeID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
  format: 'text' | 'binary';
};

type PgResult = {
  command: string;
  rowCount: number;
  oid: number;
  rows: unknown[];
  fields: PgFieldDef[];
};

class Pg8Query extends EventEmitter {
  fieldsEmitted = 0;

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'fields') {
      this.fieldsEmitted += 1;
      throw new Error('pg 8.x Query does not emit a fields event');
    }
    return super.emit(event, ...args);
  }
}

function pgResult(columnNames: string[], rowCount = 0): PgResult {
  return {
    command: 'SELECT',
    rowCount,
    oid: 0,
    rows: [],
    fields: columnNames.map((name, index) => ({
      name,
      tableID: 0,
      columnID: index + 1,
      dataTypeID: 25,
      dataTypeSize: -1,
      dataTypeModifier: -1,
      format: 'text',
    })),
  };
}

function clientThatRuns(queryEvents: (query: Pg8Query) => void): {
  query: (query: Pg8Query) => void;
  connection: { stream: { destroy: () => void } };
} {
  return {
    query(query) {
      queueMicrotask(() => {
        queryEvents(query);
      });
    },
    connection: {
      stream: {
        destroy() {},
      },
    },
  };
}

async function consumePgNdjson(
  queryEvents: (query: Pg8Query) => void,
  query: Pg8Query = new Pg8Query(),
): Promise<{
  query: Pg8Query;
  ndjson: string;
  result: Awaited<ReturnType<typeof consumeNdjsonResult>>;
}> {
  const stdout = new PassThrough();
  let ndjson = '';

  const consumed = consumeNdjsonResult(stdout, {
    maxRows: 1_000,
    maxBytes: 1_000_000,
    abort: () => undefined,
  });

  await streamPgQuery(
    query,
    clientThatRuns(queryEvents),
    createStreamLimiter({ maxRows: 100, maxBytes: 1_000_000 }),
    (event) => {
      const line = encodeRunnerEvent(event);
      ndjson += line;
      stdout.write(line);
    },
  );
  stdout.end();

  return {
    query,
    ndjson,
    result: await consumed,
  };
}

describe('Postgres execute path: NDJSON meta from pg Result.fields (#11)', () => {
  it('emits NDJSON meta columns from result.fields when Query never fires fields', async () => {
    const result = pgResult(['order_date', 'daily_total'], 2);
    const { query, ndjson, result: consumed } = await consumePgNdjson((q) => {
      q.emit('row', ['2026-08-22T00:00:00.000Z', '103387.00'], result);
      q.emit('row', ['2026-08-23T00:00:00.000Z', '99100.00'], result);
      q.emit('end', result);
    });

    assert.equal(
      query.fieldsEmitted,
      0,
      'regression must not rely on a pg client fields event',
    );
    assert.match(
      ndjson,
      /^\{"type":"meta","columns":\["order_date","daily_total"\]\}\n/,
    );
    assert.deepEqual(consumed.columns, ['order_date', 'daily_total']);
    assert.deepEqual(consumed.rows, [
      ['2026-08-22T00:00:00.000Z', '103387.00'],
      ['2026-08-23T00:00:00.000Z', '99100.00'],
    ]);
    assert.equal(consumed.truncated, false);
    assert.equal(consumed.error, undefined);
  });

  it('emits NDJSON meta from result.fields on end for a zero-row result with a schema', async () => {
    const result = pgResult(['id', 'email'], 0);
    const { query, ndjson, result: consumed } = await consumePgNdjson((q) => {
      q.emit('end', result);
    });

    assert.equal(query.fieldsEmitted, 0);
    assert.equal(
      ndjson,
      '{"type":"meta","columns":["id","email"]}\n{"type":"end","truncated":false}\n',
    );
    assert.deepEqual(consumed.columns, ['id', 'email']);
    assert.deepEqual(consumed.rows, []);
  });

  it('does not wait for a fields listener to fire before writing meta', async () => {
    const query = new Pg8Query();
    const result = pgResult(['n'], 1);
    const { ndjson, result: consumed } = await consumePgNdjson((q) => {
      q.emit('row', [1], result);
      q.emit('end', result);
    }, query);

    assert.equal(query.fieldsEmitted, 0);
    assert.ok(
      !ndjson.includes('"type":"fields"'),
      'runner NDJSON has no fields event; only meta/row/end',
    );
    assert.deepEqual(consumed.columns, ['n']);
    assert.deepEqual(consumed.rows, [[1]]);
  });
});

describe('Postgres execute.js wiring does not use the fields event', () => {
  it('streamPg delegates to streamPgQuery and does not listen for fields', () => {
    const src = readFileSync(
      new URL('../sandbox/execute.js', import.meta.url),
      'utf8',
    );
    const streamPg = src.slice(
      src.indexOf('function streamPg'),
      src.indexOf('async function runMysql'),
    );
    assert.match(streamPg, /streamPgQuery\(/);
    assert.doesNotMatch(streamPg, /query\.on\(\s*['"]fields['"]/);
    assert.doesNotMatch(
      streamPg,
      /writeEvent\(\s*\{\s*type:\s*['"]meta['"]/,
    );
  });

  it('pg-query-stream reads column names from result.fields on row and end', () => {
    const src = readFileSync(
      new URL('../sandbox/pg-query-stream.js', import.meta.url),
      'utf8',
    );
    assert.match(src, /result\?\.fields/);
    assert.match(src, /query\.on\(\s*['"]row['"]/);
    assert.match(src, /query\.on\(\s*['"]end['"]/);
  });
});
