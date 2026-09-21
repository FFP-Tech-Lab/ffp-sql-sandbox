import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { createStreamLimiter } from '../sandbox/stream-limit.js';
import { consumeNdjsonResult } from '../src/stream-consumer.js';

function rowBytes(values: unknown[]): number {
  return Buffer.byteLength(JSON.stringify(values), 'utf8');
}

describe('streaming maxRows / maxBytes (runner limiter)', () => {
  it('stops before buffering the remaining rows once maxRows is reached', () => {
    const limiter = createStreamLimiter({ maxRows: 3, maxBytes: 1_000_000 });
    const produced: unknown[][] = [];
    let cancelled = false;

    for (let i = 0; i < 10_000; i += 1) {
      const decision = limiter.push([i]);
      if (!decision.accept) {
        cancelled = true;
        break;
      }
      produced.push([i]);
    }

    assert.equal(produced.length, 3);
    assert.equal(cancelled, true);
    assert.equal(limiter.state.truncated, true);
    assert.equal(limiter.state.reason, 'maxRows');
    assert.ok(limiter.state.rows <= 3);
  });

  it('stops before buffering the remaining rows once maxBytes is reached', () => {
    const payload = ['x'.repeat(100)];
    const oneRow = rowBytes(payload);
    const limiter = createStreamLimiter({
      maxRows: 10_000,
      maxBytes: oneRow * 2 + 10,
    });
    const produced: unknown[][] = [];

    for (let i = 0; i < 50; i += 1) {
      const decision = limiter.push(payload);
      if (!decision.accept) {
        break;
      }
      produced.push(payload);
    }

    assert.ok(produced.length >= 1);
    assert.ok(produced.length <= 2);
    assert.equal(limiter.state.truncated, true);
    assert.equal(limiter.state.reason, 'maxBytes');
    const buffered = produced.reduce((sum, row) => sum + rowBytes(row), 0);
    assert.ok(buffered <= oneRow * 2 + 10);
  });
});

describe('streaming maxRows / maxBytes (host consumer backstop)', () => {
  it('aborts the docker stream instead of demux-then-truncating a full buffer', async () => {
    let pulledChunks = 0;
    const row = '{"type":"row","values":["' + 'n'.repeat(200) + '"]}\n';
    const totalRows = 200;
    let aborted = false;

    const stream = Readable.from(
      (async function* gen() {
        yield Buffer.from('{"type":"meta","columns":["v"]}\n', 'utf8');
        for (let i = 0; i < totalRows; i += 1) {
          if (aborted) {
            throw new Error('stream continued after abort — demux-then-truncate');
          }
          pulledChunks += 1;
          yield Buffer.from(row, 'utf8');
        }
        yield Buffer.from('{"type":"end","truncated":false}\n', 'utf8');
      })(),
    );

    const result = await consumeNdjsonResult(stream, {
      maxRows: 1_000,
      maxBytes: 800,
      abort: () => {
        aborted = true;
        stream.destroy();
      },
    });

    assert.equal(result.truncated, true);
    assert.ok(pulledChunks < totalRows, `pulled ${pulledChunks} of ${totalRows} chunks`);
    assert.ok(result.rows.length < totalRows);
  });

  it('marks truncated when maxRows is hit on the host consumer', async () => {
    const lines = [
      '{"type":"meta","columns":["n"]}',
      '{"type":"row","values":[1]}',
      '{"type":"row","values":[2]}',
      '{"type":"row","values":[3]}',
      '{"type":"row","values":[4]}',
      '{"type":"end","truncated":false}',
      '',
    ];
    let aborted = false;
    const stream = Readable.from([Buffer.from(lines.join('\n'), 'utf8')]);
    const result = await consumeNdjsonResult(stream, {
      maxRows: 2,
      maxBytes: 1_000_000,
      abort: () => {
        aborted = true;
      },
    });
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.rows, [[1], [2]]);
    assert.equal(result.truncated, true);
    assert.equal(aborted, true);
  });

  it('does not throw when a line is concatenated JSON (mux corruption backstop)', async () => {
    const line =
      '{"type":"meta","columns":["SLEEP(15)"]}{"type":"row","values":[0]}\n';
    const stream = Readable.from([Buffer.from(line, 'utf8')]);
    const result = await consumeNdjsonResult(stream, {
      maxRows: 10,
      maxBytes: 1_000_000,
      abort: () => undefined,
    });
    assert.equal(result.error, undefined);
  });
});
