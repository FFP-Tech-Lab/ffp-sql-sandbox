import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { demuxStdout } from '../src/docker-types.js';

function dockerMuxFrame(streamType: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

async function collect(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('demuxStdout (Tty:false always multiplexed)', () => {
  it('does not stick as non-mux when the first chunk is <8 bytes, then a type-1 frame body', async () => {
    const payload = '{"type":"meta","columns":["n"]}\n{"type":"row","values":[1]}\n';
    const frame = dockerMuxFrame(1, payload);
    assert.ok(frame.length > 8);
    const stream = Readable.from([frame.subarray(0, 5), frame.subarray(5)]);
    const output = await collect(demuxStdout(stream));
    assert.equal(output.toString('utf8'), payload);
    assert.equal(output[0], '{'.charCodeAt(0));
    assert.notEqual(output[0], 1);
  });

  it('reassembles a mux frame split across many tiny chunks', async () => {
    const payload = '{"type":"end","truncated":false}\n';
    const frame = dockerMuxFrame(1, payload);
    const pieces: Buffer[] = [];
    for (let i = 0; i < frame.length; i += 1) {
      pieces.push(frame.subarray(i, i + 1));
    }
    const output = await collect(demuxStdout(Readable.from(pieces)));
    assert.equal(output.toString('utf8'), payload);
  });

  it('forwards type-2 mux error NDJSON to the consumer', async () => {
    const errorLine = '{"type":"error","error":"secret missing"}\n';
    const stderrFrame = dockerMuxFrame(2, errorLine);
    const output = await collect(demuxStdout(Readable.from([stderrFrame])));
    assert.equal(output.toString('utf8'), errorLine);
  });
});
