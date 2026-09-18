import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { readPassword } from '../sandbox/secrets.js';
import { encodeRunnerEvent, writeRunnerError } from '../sandbox/events.js';
import { consumeNdjsonResult } from '../src/stream-consumer.js';

describe('readPassword tmpfs-only', () => {
  it('does not accept a payload.password fallback when the secret file is missing', () => {
    assert.throws(
      () => readPassword('/no/such/ffp-sql-sandbox-secret'),
      /tmpfs secret file/,
    );
  });

  it('reads only the secret file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffp-sql-sandbox-'));
    const path = join(dir, 'db_password');
    try {
      writeFileSync(path, 'file-secret', 'utf8');
      assert.equal(readPassword(path), 'file-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('execute.js does not read password from stdin JSON payload', () => {
    const src = readFileSync(new URL('../sandbox/execute.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /payload\.password/);
    assert.match(src, /readPassword\(/);
  });
});

describe('runner error events on stdout', () => {
  it('encodes errors as NDJSON that the host consumer treats as an error result', async () => {
    const line = encodeRunnerEvent({
      type: 'error',
      error: 'Database password missing (expected tmpfs secret file)',
    });
    const stream = new PassThrough();
    queueMicrotask(() => {
      stream.end(line);
    });
    const result = await consumeNdjsonResult(stream, {
      maxRows: 10,
      maxBytes: 10_000,
      abort: () => undefined,
    });
    assert.equal(
      result.error,
      'Database password missing (expected tmpfs secret file)',
    );
  });

  it('writeRunnerError writes the error event to the stdout stream', async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    writeRunnerError(new Error('relation "t" does not exist'), stream);
    stream.end();
    await new Promise<void>((resolve) => {
      stream.on('end', () => resolve());
    });
    assert.equal(
      Buffer.concat(chunks).toString('utf8'),
      '{"type":"error","error":"relation \\"t\\" does not exist"}\n',
    );
  });

  it('execute.js reports failures via writeRunnerError (stdout NDJSON), not stderr', () => {
    const src = readFileSync(new URL('../sandbox/execute.js', import.meta.url), 'utf8');
    assert.match(src, /writeRunnerError/);
    assert.doesNotMatch(src, /stderr\.write/);
  });
});
