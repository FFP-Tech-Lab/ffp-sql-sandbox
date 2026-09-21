import { PassThrough, type Readable } from 'node:stream';

export type ContainerLike = {
  start: () => Promise<unknown>;
  putArchive: (
    tar: Buffer | NodeJS.ReadableStream,
    opts: { path: string },
  ) => Promise<unknown>;
  attach: (opts: unknown) => Promise<NodeJS.ReadWriteStream | Readable>;
  wait: () => Promise<{ StatusCode: number }>;
  kill: () => Promise<unknown>;
  remove: (opts?: unknown) => Promise<unknown>;
};

export type DockerLike = {
  ping: () => Promise<unknown>;
  createContainer: (opts: Record<string, unknown>) => Promise<ContainerLike>;
};

export type DockerRunRequest = {
  image: string;
  usingDefaultImage: boolean;
  env: string[];
  password: string;
  stdinJson: string;
  memoryBytes: number;
  nanoCpus: number;
  timeoutMs: number;
  maxRows: number;
  maxBytes: number;
};

type MuxFrame = { streamType: number; payload: Buffer };

/**
 * Incrementally demux Docker's 8-byte multiplexed attach stream.
 * Tty:false attach is always multiplexed — buffer until a full 8-byte header.
 * Type-1 (stdout) and type-2 (stderr) are forwarded as **complete lines** so a
 * stderr frame cannot splice bytes into the middle of a stdout NDJSON event.
 * Runner `{type:"error"}` events on either stream are still delivered.
 */
export function demuxStdout(stream: AsyncIterable<Buffer | string>): PassThrough {
  const stdout = new PassThrough();
  let carry = Buffer.alloc(0);
  let stdoutTail: Buffer = Buffer.alloc(0);
  let stderrTail: Buffer = Buffer.alloc(0);

  void (async () => {
    try {
      for await (const chunk of stream) {
        const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const joined = Buffer.concat([carry, incoming]);
        const extracted = extractMuxed(joined);
        carry = Buffer.from(extracted.rest);
        for (const frame of extracted.frames) {
          if (frame.streamType === 1) {
            stdoutTail = emitCompleteLines(stdout, stdoutTail, frame.payload);
          } else if (frame.streamType === 2) {
            stderrTail = emitCompleteLines(stdout, stderrTail, frame.payload);
          }
        }
      }
      flushTail(stdout, stdoutTail);
      flushTail(stdout, stderrTail);
      stdout.end();
    } catch (err) {
      stdout.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return stdout;
}

function emitCompleteLines(
  out: PassThrough,
  tail: Buffer,
  payload: Buffer,
): Buffer {
  const joined = Buffer.concat([tail, payload]);
  let start = 0;
  for (let i = 0; i < joined.length; i += 1) {
    if (joined[i] === 0x0a) {
      out.write(joined.subarray(start, i + 1));
      start = i + 1;
    }
  }
  return Buffer.from(joined.subarray(start));
}

function flushTail(out: PassThrough, tail: Buffer): void {
  if (tail.length === 0) {
    return;
  }
  out.write(tail);
  if (tail[tail.length - 1] !== 0x0a) {
    out.write('\n');
  }
}

function extractMuxed(buffer: Buffer): { frames: MuxFrame[]; rest: Buffer } {
  const frames: MuxFrame[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) {
      break;
    }
    const streamType = buffer[offset] ?? 0;
    const payload = buffer.subarray(offset + 8, offset + 8 + size);
    frames.push({ streamType, payload });
    offset += 8 + size;
  }
  return {
    frames,
    rest: buffer.subarray(offset),
  };
}
