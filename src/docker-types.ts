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

/**
 * Incrementally demux Docker's 8-byte multiplexed attach stream into stdout.
 * Tty:false attach is always multiplexed — never sticky-false on a short first chunk.
 */
export function demuxStdout(stream: AsyncIterable<Buffer | string>): PassThrough {
  const stdout = new PassThrough();
  let carry = Buffer.alloc(0);

  void (async () => {
    try {
      for await (const chunk of stream) {
        const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const joined = Buffer.concat([carry, incoming]);
        const extracted = extractMuxed(joined);
        carry = Buffer.from(extracted.rest);
        if (extracted.stdout.length > 0) {
          stdout.write(extracted.stdout);
        }
      }
      stdout.end();
    } catch (err) {
      stdout.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return stdout;
}

function extractMuxed(buffer: Buffer): { stdout: Buffer; rest: Buffer } {
  const stdoutChunks: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) {
      break;
    }
    const streamType = buffer[offset];
    const payload = buffer.subarray(offset + 8, offset + 8 + size);
    if (streamType === 1) {
      stdoutChunks.push(payload);
    }
    offset += 8 + size;
  }
  return {
    stdout: Buffer.concat(stdoutChunks),
    rest: buffer.subarray(offset),
  };
}
