import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { executeSql } from '../src/execute-sql.js';
import type { ExecuteSqlDeps, ExecuteSqlInput } from '../src/execute-sql.js';
import type { DockerLike } from '../src/docker-executor.js';
import {
  filesVisibleAfterStart,
  filesVisibleToContainerProcess,
} from './docker-secret-overlay.js';

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
  muxFrames?: Buffer[] | undefined;
  waitMs?: number | undefined;
  statusCode?: number | undefined;
  pingError?: Error | undefined;
  createError?: Error | undefined;
  onCreate?: ((opts: Record<string, unknown>) => void) | undefined;
}): {
  docker: DockerLike;
  state: {
    killed: boolean;
    killCalls: number;
    created: Record<string, unknown> | null;
    putArchives: Array<{ path: string; tar: Buffer }>;
    env: string[];
    stdinWrites: Buffer[];
    startedAt: number | null;
    killedAt: number | null;
  };
} {
  const state = {
    killed: false,
    killCalls: 0,
    created: null as Record<string, unknown> | null,
    putArchives: [] as Array<{ path: string; tar: Buffer }>,
    env: [] as string[],
    stdinWrites: [] as Buffer[],
    startedAt: null as number | null,
    killedAt: null as number | null,
  };

  const docker: DockerLike = {
    async ping() {
      if (options.pingError) {
        throw options.pingError;
      }
    },
    async createContainer(createOpts: Record<string, unknown>) {
      state.created = createOpts;
      state.env = (createOpts.Env as string[] | undefined) ?? [];
      options.onCreate?.(createOpts);
      if (options.createError) {
        throw options.createError;
      }

      let settleWait: ((status: { StatusCode: number }) => void) | undefined;
      const container: FakeContainer = {
        async start() {
          state.startedAt = Date.now();
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
            chunk: unknown,
            encoding?: unknown,
            cb?: unknown,
          ) => {
            const buf = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(String(chunk), 'utf8');
            state.stdinWrites.push(buf);
            const done = typeof encoding === 'function' ? encoding : cb;
            if (typeof done === 'function') {
              (done as (error?: Error | null) => void)();
            }
            return true;
          }) as typeof stream.write;
          queueMicrotask(() => {
            const frames =
              options.muxFrames ??
              (options.stdout !== undefined
                ? [dockerMuxFrame(1, options.stdout)]
                : []);
            for (const frame of frames) {
              pushStdout(frame);
            }
            if (options.waitMs === undefined) {
              stream.end();
            }
          });
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
          state.killCalls += 1;
          state.killed = true;
          state.killedAt = Date.now();
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
    let bindSnapshot = new Map<string, Buffer>();
    const { docker, state } = createMockDocker({
      stdout: ndjson,
      onCreate(opts) {
        bindSnapshot = filesVisibleToContainerProcess({
          createOpts: opts,
          putArchives: [],
        });
      },
    });
    const result = await executeSql(baseInput(), { docker });
    assert.equal(result.ok, true);
    assert.ok(state.env.length > 0);
    for (const entry of state.env) {
      assert.doesNotMatch(entry, /PASS/i);
      assert.equal(entry.includes(SECRET), false);
    }
    const inspectDump = JSON.stringify(state.created);
    assert.equal(inspectDump.includes(SECRET), false);
    const visible = filesVisibleAfterStart({
      createOpts: state.created,
      putArchives: state.putArchives,
      bindSnapshot,
    });
    assert.equal(
      visible.get('/run/secrets/db_password')?.toString('utf8'),
      SECRET,
    );
    const hostConfig = (state.created?.HostConfig ?? {}) as {
      Mounts?: Array<{ Type?: string; Target?: string; ReadOnly?: boolean }>;
    };
    const secretMount = (hostConfig.Mounts ?? []).find(
      (mount) => mount.Target === '/run/secrets/db_password',
    );
    assert.equal(secretMount?.Type, 'bind');
    assert.equal(secretMount?.ReadOnly, true);
  });

  it('does not hide the password under a tmpfs mount of /run/secrets via putArchive', async () => {
    const ndjson = [
      '{"type":"meta","columns":["?column?"]}',
      '{"type":"row","values":[1]}',
      '{"type":"end","truncated":false}',
      '',
    ].join('\n');
    const { docker, state } = createMockDocker({ stdout: ndjson });
    const result = await executeSql(baseInput(), { docker });
    assert.equal(result.ok, true);
    const hostConfig = (state.created?.HostConfig ?? {}) as {
      Tmpfs?: Record<string, string>;
    };
    const tmpfsCoversSecrets = Object.keys(hostConfig.Tmpfs ?? {}).some(
      (target) => target === '/run/secrets' || target === '/run/secrets/',
    );
    const usedPutArchiveOnSecrets = state.putArchives.some(
      (archive) =>
        archive.path === '/run/secrets' || archive.path === '/run/secrets/',
    );
    assert.equal(
      tmpfsCoversSecrets && usedPutArchiveOnSecrets,
      false,
      'putArchive into a tmpfs-mounted /run/secrets is invisible to the container process',
    );
  });

  it('removes the host secret file after the container is torn down', async () => {
    const ndjson = [
      '{"type":"meta","columns":["?column?"]}',
      '{"type":"row","values":[1]}',
      '{"type":"end","truncated":false}',
      '',
    ].join('\n');
    let secretSource: string | undefined;
    const { docker } = createMockDocker({
      stdout: ndjson,
      onCreate(opts) {
        secretSource = bindSourceForSecret(opts);
      },
    });
    const result = await executeSql(baseInput(), { docker });
    assert.equal(result.ok, true);
    assert.equal(typeof secretSource, 'string');
    assert.equal(existsSync(secretSource ?? ''), false);
  });

  it('removes the host secret file when createContainer fails', async () => {
    let secretSource: string | undefined;
    const { docker } = createMockDocker({
      createError: new Error('create failed'),
      onCreate(opts) {
        secretSource = bindSourceForSecret(opts);
      },
    });
    const result = await executeSql(baseInput(), { docker });
    assert.equal(result.ok, false);
    assert.equal(typeof secretSource, 'string');
    assert.equal(existsSync(secretSource ?? ''), false);
  });
});

function bindSourceForSecret(
  createOpts: Record<string, unknown>,
): string | undefined {
  const hostConfig = (createOpts.HostConfig ?? {}) as {
    Mounts?: Array<{ Type?: string; Source?: string; Target?: string }>;
    Binds?: string[];
  };
  for (const mount of hostConfig.Mounts ?? []) {
    if (
      mount.Type === 'bind' &&
      (mount.Target === '/run/secrets/db_password' ||
        mount.Target === '/run/secrets')
    ) {
      return mount.Source;
    }
  }
  for (const entry of hostConfig.Binds ?? []) {
    const parts = entry.split(':');
    if (
      parts[1] === '/run/secrets/db_password' ||
      parts[1] === '/run/secrets'
    ) {
      return parts[0];
    }
  }
  return undefined;
}

describe('executeSql timeout path', () => {
  it('sets QUERY_TIMEOUT and kills the container at timeoutMs+2000', async () => {
    const timeoutMs = 80;
    const { docker, state } = createMockDocker({
      waitMs: 30_000,
      stdout: undefined,
    });
    const result = await executeSql(baseInput({ limits: { timeoutMs } }), {
      docker,
    });
    assert.ok(state.env.includes(`QUERY_TIMEOUT=${timeoutMs}`));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'TIMEOUT');
    }
    assert.equal(state.killed, true);
    assert.ok(state.startedAt !== null && state.killedAt !== null);
    const killDelay = (state.killedAt ?? 0) - (state.startedAt ?? 0);
    assert.ok(
      killDelay >= timeoutMs + 1_800,
      `container kill too early (${killDelay}ms); expected ~timeoutMs+2000`,
    );
    assert.ok(
      killDelay <= timeoutMs + 2_400,
      `container kill too late (${killDelay}ms); expected ~timeoutMs+2000`,
    );
  });
});

describe('executeSql stdin and env contract', () => {
  it('writes stdinJson with only { sql } (no password field)', async () => {
    const ndjson = [
      '{"type":"meta","columns":["?column?"]}',
      '{"type":"row","values":[1]}',
      '{"type":"end","truncated":false}',
      '',
    ].join('\n');
    const { docker, state } = createMockDocker({ stdout: ndjson });
    const result = await executeSql(baseInput({ sql: 'SELECT 1' }), { docker });
    assert.equal(result.ok, true);
    const raw = Buffer.concat(state.stdinWrites).toString('utf8').trim();
    const payload = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ['sql']);
    assert.equal(payload.sql, 'SELECT 1');
    assert.equal('password' in payload, false);
    assert.equal(JSON.stringify(payload).includes(SECRET), false);
  });
});

describe('executeSql runner failure on stdout', () => {
  it('returns the runner error message from stdout NDJSON, not a generic exit status', async () => {
    const { docker } = createMockDocker({
      stdout: '{"type":"error","error":"relation \\"t\\" does not exist"}\n',
      statusCode: 1,
    });
    const result = await executeSql(baseInput(), { docker });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'EXECUTION_FAILED');
      assert.match(result.error, /relation "t" does not exist/);
      assert.notEqual(
        result.error,
        'Sandbox runner exited with a non-zero status',
      );
    }
  });

  it('surfaces a type-2 mux error event through the host path', async () => {
    const { docker } = createMockDocker({
      muxFrames: [
        dockerMuxFrame(2, '{"type":"error","error":"secret missing"}\n'),
      ],
      statusCode: 1,
    });
    const result = await executeSql(baseInput(), { docker });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'EXECUTION_FAILED');
      assert.equal(result.error, 'secret missing');
      assert.notEqual(
        result.error,
        'Sandbox runner exited with a non-zero status',
      );
    }
  });
});

describe('executeSql mux streaming truncation', () => {
  it('sets truncated and aborts when maxRows is hit on the mux stream', async () => {
    const lines = ['{"type":"meta","columns":["n"]}'];
    for (let i = 0; i < 20; i += 1) {
      lines.push(`{"type":"row","values":[${i}]}`);
    }
    lines.push('{"type":"end","truncated":false}', '');
    const { docker, state } = createMockDocker({
      muxFrames: [dockerMuxFrame(1, lines.join('\n'))],
    });
    const result = await executeSql(baseInput({ limits: { maxRows: 3 } }), {
      docker,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.truncated, true);
      assert.equal(result.data.rows.length, 3);
    }
    assert.ok(state.killCalls >= 2);
  });

  it('sets truncated and aborts when maxBytes is hit on the mux stream', async () => {
    const row = `{"type":"row","values":["${'n'.repeat(200)}"]}`;
    const lines = [
      '{"type":"meta","columns":["v"]}',
      ...Array.from({ length: 30 }, () => row),
      '{"type":"end","truncated":false}',
      '',
    ];
    const { docker, state } = createMockDocker({
      muxFrames: [dockerMuxFrame(1, lines.join('\n'))],
    });
    const result = await executeSql(baseInput({ limits: { maxBytes: 400 } }), {
      docker,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.truncated, true);
      assert.ok(result.data.rows.length < 30);
    }
    assert.ok(state.killCalls >= 2);
  });
});

describe('executeSql fail-fast skips Docker', () => {
  it('rejects SELECT 1; SELECT 2 as MULTI_STATEMENT without creating a container', async () => {
    const { docker, state } = createMockDocker({ stdout: '' });
    const result = await executeSql(baseInput({ sql: 'SELECT 1; SELECT 2' }), {
      docker,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'MULTI_STATEMENT');
    }
    assert.equal(state.created, null);
  });
});

describe('executeSql missing image', () => {
  it('returns IMAGE_UNAVAILABLE when the default digest cannot be created or pulled', async () => {
    const { docker } = createMockDocker({
      createError: new Error(
        '(HTTP code 404) no such image: ghcr.io/ffp-tech-lab/ffp-sql-sandbox-runner@sha256:deadbeef',
      ),
    });
    const result = await executeSql(baseInput(), { docker });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'IMAGE_UNAVAILABLE');
      assert.match(result.error, /sandbox\/Dockerfile/);
      assert.match(result.error, /image/i);
    }
  });
});
