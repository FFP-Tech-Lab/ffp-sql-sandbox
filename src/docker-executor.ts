import {
  accessSync,
  chmodSync,
  constants,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { consumeNdjsonResult } from './stream-consumer.js';
import {
  demuxStdout,
  type DockerLike,
  type DockerRunRequest,
} from './docker-types.js';
import type { ExecuteSqlResult } from './types.js';

export type { DockerLike, DockerRunRequest } from './docker-types.js';

const CONTAINER_KILL_GRACE_MS = 2_000;
const SECRET_MOUNT = '/run/secrets';
const SECRET_FILENAME = 'db_password';
const SECRET_CONTAINER_PATH = `${SECRET_MOUNT}/${SECRET_FILENAME}`;

export function createDefaultDocker(): DockerLike {
  return new Docker() as unknown as DockerLike;
}

export async function runInSandbox(
  docker: DockerLike,
  request: DockerRunRequest,
): Promise<ExecuteSqlResult> {
  let container: Awaited<ReturnType<DockerLike['createContainer']>> | null =
    null;
  let timedOut = false;
  let killedForLimit = false;
  let attachStream: NodeJS.ReadWriteStream | NodeJS.ReadableStream | null =
    null;
  let secretDir: string | undefined;

  const containerTimeoutMs = request.timeoutMs + CONTAINER_KILL_GRACE_MS;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    // Bind-mount a host ephemeral file. Docker putArchive writes into the
    // image layer *beneath* mounts, so tmpfs + putArchive left /run/secrets
    // empty inside the container.
    const staged = stageHostSecret(request.password);
    secretDir = staged.dir;
    container = await docker.createContainer({
      Image: request.image,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: true,
      Tty: false,
      Env: request.env,
      HostConfig: {
        Memory: request.memoryBytes,
        MemorySwap: request.memoryBytes,
        NanoCpus: request.nanoCpus,
        NetworkMode: 'bridge',
        ExtraHosts: ['host.docker.internal:host-gateway'],
        AutoRemove: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        PidsLimit: 256,
        Mounts: [
          {
            Type: 'bind',
            Source: staged.filePath,
            Target: SECRET_CONTAINER_PATH,
            ReadOnly: true,
          },
        ],
      },
      Labels: {
        'ffp.sql-sandbox': 'v1',
      },
    });

    await container.start();
    killTimer = setTimeout(() => {
      timedOut = true;
      void container?.kill().catch(() => undefined);
      destroyStream(attachStream);
    }, containerTimeoutMs);

    attachStream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    });

    const writable = attachStream as NodeJS.WritableStream;
    if (typeof writable.write === 'function') {
      writable.write(request.stdinJson);
      if (typeof writable.end === 'function') {
        writable.end();
      }
    }

    const stdout = demuxStdout(attachStream as AsyncIterable<Buffer | string>);
    const consumed = consumeNdjsonResult(stdout, {
      maxRows: request.maxRows,
      maxBytes: request.maxBytes,
      abort: () => {
        killedForLimit = true;
        destroyStream(attachStream);
        void container?.kill().catch(() => undefined);
      },
    });

    const wait = container.wait();
    let hangTimer: ReturnType<typeof setTimeout> | undefined;
    const hang = new Promise<never>((_, reject) => {
      hangTimer = setTimeout(() => {
        timedOut = true;
        reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
      }, containerTimeoutMs + 50);
    });

    let result: {
      data: Awaited<typeof consumed>;
      status: { StatusCode: number };
    };
    try {
      result = await Promise.race([
        Promise.all([consumed, wait]).then(([data, status]) => ({
          data,
          status,
        })),
        hang,
      ]);
    } finally {
      if (hangTimer !== undefined) {
        clearTimeout(hangTimer);
      }
    }

    if (timedOut) {
      return {
        ok: false,
        code: 'TIMEOUT',
        error: `SQL execution timed out after ${request.timeoutMs}ms (container kill + statement_timeout)`,
      };
    }

    if (result.data.error) {
      return { ok: false, code: 'EXECUTION_FAILED', error: result.data.error };
    }

    if (result.status.StatusCode !== 0 && !result.data.truncated && !killedForLimit) {
      return {
        ok: false,
        code: 'EXECUTION_FAILED',
        error: result.data.error ?? 'Sandbox runner exited with a non-zero status',
      };
    }

    const data: { columns: string[]; rows: unknown[][]; truncated?: boolean } = {
      columns: result.data.columns,
      rows: result.data.rows,
    };
    if (result.data.truncated) {
      data.truncated = true;
    }
    return { ok: true, data };
  } catch (err) {
    if (timedOut) {
      return {
        ok: false,
        code: 'TIMEOUT',
        error: `SQL execution timed out after ${request.timeoutMs}ms (container kill + statement_timeout)`,
      };
    }
    if (isImageUnavailableError(err)) {
      return {
        ok: false,
        code: 'IMAGE_UNAVAILABLE',
        error: imageUnavailableMessage(request),
      };
    }
    return {
      ok: false,
      code: 'EXECUTION_FAILED',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
    destroyStream(attachStream);
    if (container) {
      try {
        await container.kill();
      } catch {
        // already exited
      }
      try {
        await container.remove({ force: true });
      } catch {
        // already removed
      }
    }
    removeHostSecret(secretDir);
  }
}

function stageHostSecret(password: string): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(hostSecretParent(), 'ffp-sql-sandbox-'));
  try {
    chmodSync(dir, 0o700);
    const filePath = join(dir, SECRET_FILENAME);
    writeFileSync(filePath, password, { encoding: 'utf8', mode: 0o444 });
    chmodSync(filePath, 0o444);
    return { dir, filePath };
  } catch (err) {
    removeHostSecret(dir);
    throw err;
  }
}

function hostSecretParent(): string {
  try {
    accessSync('/dev/shm', constants.W_OK);
    return '/dev/shm';
  } catch {
    return tmpdir();
  }
}

function removeHostSecret(dir: string | undefined): void {
  if (!dir) {
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort; container teardown still proceeds
  }
}

function destroyStream(
  stream: NodeJS.ReadWriteStream | NodeJS.ReadableStream | null,
): void {
  if (!stream) {
    return;
  }
  if ('destroy' in stream && typeof stream.destroy === 'function') {
    stream.destroy();
  }
}

function isImageUnavailableError(err: unknown): boolean {
  const status =
    typeof err === 'object' && err !== null && 'statusCode' in err
      ? Number((err as { statusCode: unknown }).statusCode)
      : undefined;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    status === 404 ||
    /no such image/i.test(msg) ||
    /\(HTTP code 404\).*image/i.test(msg)
  );
}

function imageUnavailableMessage(request: DockerRunRequest): string {
  if (request.usingDefaultImage) {
    return `Default sandbox image is not pullable (${request.image}). Pull ghcr.io/ffp-tech-lab/ffp-sql-sandbox-runner@sha256:<digest> (or :v1), or build sandbox/Dockerfile locally and pass image: '<tag-or-id>' (untrusted override). If docker pull is unauthorized, the GHCR package may still be private.`;
  }
  return `Sandbox image not found: ${request.image}. Build or pull it before calling executeSql.`;
}

