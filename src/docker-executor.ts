import Docker from 'dockerode';
import { createPasswordTar } from './password-tar.js';
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

  const containerTimeoutMs = request.timeoutMs + CONTAINER_KILL_GRACE_MS;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  try {
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
        Tmpfs: {
          [SECRET_MOUNT]: 'rw,noexec,nosuid,size=1m,mode=0700,uid=1000,gid=1000',
        },
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
    await container.putArchive(createPasswordTar(request.password), {
      path: SECRET_MOUNT,
    });

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

