import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createPasswordTar } from '../src/password-tar.js';
import { filesVisibleToContainerProcess } from './docker-secret-overlay.js';

describe('Docker putArchive vs tmpfs overlay', () => {
  it('hides putArchive files under a tmpfs mount at the same path', () => {
    const visible = filesVisibleToContainerProcess({
      createOpts: {
        HostConfig: {
          Tmpfs: {
            '/run/secrets':
              'rw,noexec,nosuid,size=1m,mode=0700,uid=1000,gid=1000',
          },
        },
      },
      putArchives: [
        { path: '/run/secrets', tar: createPasswordTar('from-archive') },
      ],
    });
    assert.equal(visible.has('/run/secrets/db_password'), false);
  });

  it('shows putArchive files when the destination is not tmpfs-mounted', () => {
    const visible = filesVisibleToContainerProcess({
      createOpts: { HostConfig: {} },
      putArchives: [
        { path: '/run/secrets', tar: createPasswordTar('from-archive') },
      ],
    });
    assert.equal(
      visible.get('/run/secrets/db_password')?.toString('utf8'),
      'from-archive',
    );
  });

  it('shows a bind-mounted secret file even when tmpfs covers /run/secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffp-sql-sandbox-overlay-'));
    const filePath = join(dir, 'db_password');
    try {
      writeFileSync(filePath, 'from-bind', { encoding: 'utf8', mode: 0o444 });
      const visible = filesVisibleToContainerProcess({
        createOpts: {
          HostConfig: {
            Tmpfs: {
              '/run/secrets':
                'rw,noexec,nosuid,size=1m,mode=0700,uid=1000,gid=1000',
            },
            Mounts: [
              {
                Type: 'bind',
                Source: filePath,
                Target: '/run/secrets/db_password',
                ReadOnly: true,
              },
            ],
          },
        },
        putArchives: [
          { path: '/run/secrets', tar: createPasswordTar('from-archive') },
        ],
      });
      assert.equal(
        visible.get('/run/secrets/db_password')?.toString('utf8'),
        'from-bind',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
