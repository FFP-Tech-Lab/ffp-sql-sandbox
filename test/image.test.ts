import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULT_SANDBOX_IMAGE, isDigestPinnedImage } from '../src/image.js';
import { executeSql } from '../src/execute-sql.js';
import type { DockerLike } from '../src/docker-executor.js';

describe('default image digest pin', () => {
  it('pins the default runner image by sha256 digest', () => {
    assert.equal(isDigestPinnedImage(DEFAULT_SANDBOX_IMAGE), true);
    assert.match(
      DEFAULT_SANDBOX_IMAGE,
      /^ghcr\.io\/ffp-tech-lab\/ffp-sql-sandbox-runner@sha256:[a-f0-9]{64}$/,
    );
  });

  it('pins the runner Dockerfile FROM line by digest', () => {
    const dockerfile = readFileSync(
      new URL('../sandbox/Dockerfile', import.meta.url),
      'utf8',
    );
    assert.match(
      dockerfile,
      /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/m,
    );
  });

  it('treats a custom image override as untrusted', async () => {
    let createdImage: string | undefined;
    const docker: DockerLike = {
      async ping() {
        /* ok */
      },
      async createContainer(opts: Record<string, unknown>) {
        createdImage = opts.Image as string;
        throw new Error('stop-before-start');
      },
    };

    const result = await executeSql(
      {
        sql: 'SELECT 1',
        connection: {
          type: 'postgres',
          host: 'db.internal',
          port: 5432,
          user: 'ro',
          password: 'p',
          database: 'app',
        },
        hostAllowlist: ['db.internal'],
        image: 'evil.example/untrusted:latest',
      },
      { docker },
    );

    assert.equal(createdImage, 'evil.example/untrusted:latest');
    assert.equal(result.ok, false);
  });
});
