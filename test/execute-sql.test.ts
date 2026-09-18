import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { executeSql } from '../src/execute-sql.js';
import type { ExecuteSqlDeps, ExecuteSqlInput } from '../src/execute-sql.js';
import type { DockerLike } from '../src/docker-executor.js';

const SECRET = 'super-secret-password';

function baseInput(
  overrides: Partial<ExecuteSqlInput> = {},
): ExecuteSqlInput {
  return {
    sql: 'SELECT 1',
    connection: {
      type: 'postgres',
      host: 'db.internal',
      port: 5432,
      user: 'readonly',
      password: SECRET,
      database: 'app',
    },
    hostAllowlist: ['db.internal'],
    ...overrides,
  };
}

function dockerMuxFrame(streamType: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

type FakeContainer = {
  start: () => Promise<void>;
  putArchive: (tar: Buffer | NodeJS.ReadableStream, opts: { path: string }) => Promise<void>;
  attach: (opts: unknown) => Promise<PassThrough>;
  wait: () => Promise<{ StatusCode: number }>;
  kill: () => Promise<void>;
  remove: (opts?: unknown) => Promise<void>;
  inspect?: () => Promise<unknown>;
};

function createMockDocker(options: {
  stdout?: string | undefined;
  waitMs?: number | undefined;
  statusCode?: number | undefined;
  pingError?: Error | undefined;
  createError?: Error | undefined;
  onCreate?: ((opts: Record<string, unknown>) => void) | undefined;
}): { docker: DockerLike; state: { killed: boolean; created: Record<string, unknown> | null; putArchives: Array<{ path: string; tar: Buffer }>; env: string[] } } {
  const state = {
    killed: false,
    created: null as Record<string, unknown> | null,
    putArchives: [] as Array<{ path: string; tar: Buffer }>,
    env: [] as string[],
  };

  const docker: DockerLike = {
    async ping() {
      if (options.pingError) {
        throw options.pingError;
      }
    },
    async createContainer(createOpts: Record<string, unknown>) {
      if (options.createError) {
        throw options.createError;
      }
      state.created = createOpts;
      state.env = (createOpts.Env as string[] | undefined) ?? [];
      options.onCreate?.(createOpts);

      const stdin = new PassThrough();
      let settleWait: ((status: { StatusCode: number }) => void) | undefined;
      const container: FakeContainer = {
        async start() {
          /* started */
        },
        async putArchive(tar, opts) {
          const buffer = Buffer.isBuffer(tar)
            ? tar
            : await readableToBuffer(tar);
          state.putArchives.push({ path: opts.path, tar: buffer });
        },
        async attach() {
          const stream = new PassThrough();
          const pushStdout = stream.write.bind(stream);
          stream.write = ((
            _chunk: unknown,
            encoding?: unknown,
            cb?: unknown,
          ) => {
            // Host stdin (SQL JSON). Discard so it does not mix with muxed stdout.
            const done = typeof encoding === 'function' ? encoding : cb;
            if (typeof done === 'function') {
              (done as (error?: Error | null) => void)();
            }
            return true;
          }) as typeof stream.write;
          queueMicrotask(() => {
            if (options.stdout !== undefined) {
              pushStdout(dockerMuxFrame(1, options.stdout));
            }
            if (options.waitMs === undefined) {
              stream.end();
            }
          });
          void stdin;
          return stream;
        },
        wait() {
          return new Promise((resolve) => {
            let settled = false;
            const finish = (status: { StatusCode: number }) => {
              if (settled) {
                return;
              }
              settled = true;
              resolve(status);
            };
            settleWait = finish;
            if (options.waitMs === undefined) {
              finish({ StatusCode: options.statusCode ?? 0 });
              return;
            }
            const timer = setTimeout(() => {
              finish({ StatusCode: options.statusCode ?? 0 });
            }, options.waitMs);
            const previous = settleWait;
            settleWait = (status) => {
              clearTimeout(timer);
              previous?.(status);
            };
          });
        },
        async kill() {
          state.killed = true;
          settleWait?.({ StatusCode: 137 });
        },
        async remove() {
          /* removed */
        },
      };
      return container;
    },
  };

  return { docker, state };
}

async function readableToBuffer(
  stream: NodeJS.ReadableStream,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('executeSql hostAllowlist', () => {
  it('rejects a connection host that is not on the allowlist without starting Docker', async () => {
    const { docker, state } = createMockDocker({ stdout: '' });
    const result = await executeSql(
      baseInput({
        connection: {
          type: 'postgres',
          host: 'evil.example',
          port: 5432,
          user: 'readonly',
          password: SECRET,
          database: 'app',
        },
        hostAllowlist: ['db.internal'],
      }),
      { docker } satisfies ExecuteSqlDeps,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'HOST_NOT_ALLOWED');
      assert.match(result.error, /allowlist/i);
    }
    assert.equal(state.created, null);
  });

  it('rejects an empty allowlist', async () => {
    const { docker, state } = createMockDocker({ stdout: '' });
    const result = await executeSql(baseInput({ hostAllowlist: [] }), {
      docker,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'HOST_NOT_ALLOWED');
    }
    assert.equal(state.created, null);
  });

  it('fails fast on invalid SQL before Docker is used', async () => {
    const { docker, state } = createMockDocker({ stdout: '' });
    const result = await executeSql(baseInput({ sql: 'DELETE FROM t' }), {
      docker,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'NOT_READ_ONLY_PREFIX');
    }
    assert.equal(state.created, null);
  });
});

describe('executeSql Docker availability and secrets', () => {
  it('returns DOCKER_UNAVAILABLE when the engine cannot be pinged', async () => {
    const { docker } = createMockDocker({
      pingError: new Error('connect ENOENT'),
    });
    const result = await executeSql(baseInput(), { docker });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'DOCKER_UNAVAILABLE');
      assert.match(result.error, /Docker/i);
    }
  });

  it('never places the password in container Env', async () => {
    const ndjson = [
      '{"type":"meta","columns":["?column?"]}',
      '{"type":"row","values":[1]}',
      '{"type":"end","truncated":false}',
      '',
    ].join('\n');
    const { docker, state } = createMockDocker({ stdout: ndjson });
    const result = await executeSql(baseInput(), { docker });
    assert.equal(result.ok, true);
    assert.ok(state.env.length > 0);
    for (const entry of state.env) {
      assert.doesNotMatch(entry, /PASS/i);
      assert.equal(entry.includes(SECRET), false);
    }
    const inspectDump = JSON.stringify(state.created);
    assert.equal(inspectDump.includes(SECRET), false);
    assert.ok(state.putArchives.length >= 1);
    assert.equal(state.putArchives[0]?.path, '/run/secrets');
    assert.ok(state.putArchives[0]?.tar.includes(Buffer.from(SECRET)));
  });
});

describe('executeSql timeout path', () => {
  it('kills the container when execution exceeds timeoutMs', async () => {
    const { docker, state } = createMockDocker({
      waitMs: 30_000,
      stdout: undefined,
    });
    const started = Date.now();
    const result = await executeSql(
      baseInput({ limits: { timeoutMs: 50 } }),
      { docker },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `timeout path took too long: ${elapsed}ms`);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'TIMEOUT');
    }
    assert.equal(state.killed, true);
  });
});
