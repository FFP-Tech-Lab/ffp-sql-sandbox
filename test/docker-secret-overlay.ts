import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * Approximate the files a container process can read after Docker applies
 * create-time mounts, then putArchive.
 *
 * Docker `putArchive` / `docker cp` writes into the container image/writable
 * layer. A tmpfs (or other) mount at that path hides those files. Bind mounts
 * are visible in the container mount namespace.
 */
export function filesVisibleToContainerProcess(input: {
  createOpts: Record<string, unknown> | null;
  putArchives: Array<{ path: string; tar: Buffer }>;
}): Map<string, Buffer> {
  const visible = new Map<string, Buffer>();
  if (!input.createOpts) {
    return visible;
  }

  for (const archive of input.putArchives) {
    for (const file of extractUstarFiles(archive.tar)) {
      const dest = posix.normalize(posix.join(archive.path, file.name));
      visible.set(dest, file.content);
    }
  }

  const tmpfsTargets = collectTmpfsTargets(input.createOpts);
  for (const path of [...visible.keys()]) {
    if (coveredByMount(path, tmpfsTargets)) {
      visible.delete(path);
    }
  }

  for (const bind of collectBindMounts(input.createOpts)) {
    applyBindMount(visible, bind.source, bind.target);
  }

  return visible;
}

/**
 * Combine bind-mounts snapshotted at createContainer (host files may be
 * unlinked in `finally`) with putArchive bytes recorded after start.
 */
export function filesVisibleAfterStart(input: {
  createOpts: Record<string, unknown> | null;
  putArchives: Array<{ path: string; tar: Buffer }>;
  bindSnapshot: Map<string, Buffer>;
}): Map<string, Buffer> {
  const fromArchives = filesVisibleToContainerProcess({
    createOpts: withoutBindMounts(input.createOpts),
    putArchives: input.putArchives,
  });
  const visible = new Map(fromArchives);
  for (const [path, content] of input.bindSnapshot) {
    visible.set(path, content);
  }
  return visible;
}

function withoutBindMounts(
  createOpts: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!createOpts) {
    return createOpts;
  }
  const hostConfig = {
    ...((createOpts.HostConfig ?? {}) as Record<string, unknown>),
  };
  delete hostConfig.Binds;
  if (Array.isArray(hostConfig.Mounts)) {
    hostConfig.Mounts = (
      hostConfig.Mounts as Array<Record<string, unknown>>
    ).filter((mount) => mount.Type !== 'bind');
  }
  return { ...createOpts, HostConfig: hostConfig };
}

export function extractUstarFiles(
  tar: Buffer,
): Array<{ name: string; content: Buffer }> {
  const files: Array<{ name: string; content: Buffer }> = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = header
      .subarray(0, 100)
      .toString('utf8')
      .replace(/\0.*$/u, '');
    if (!name) {
      break;
    }
    const sizeOctal = header
      .subarray(124, 136)
      .toString('utf8')
      .replace(/\0.*$/u, '')
      .trim();
    const size = Number.parseInt(sizeOctal, 8) || 0;
    const contentStart = offset + 512;
    files.push({
      name,
      content: tar.subarray(contentStart, contentStart + size),
    });
    const padded = size % 512 === 0 ? size : size + (512 - (size % 512));
    offset = contentStart + padded;
  }
  return files;
}

function collectTmpfsTargets(createOpts: Record<string, unknown>): Set<string> {
  const targets = new Set<string>();
  const hostConfig = (createOpts.HostConfig ?? {}) as Record<string, unknown>;
  const tmpfs = (hostConfig.Tmpfs ?? {}) as Record<string, string>;
  for (const target of Object.keys(tmpfs)) {
    targets.add(posix.normalize(target));
  }
  for (const mount of asMounts(hostConfig.Mounts)) {
    if (mount.Type === 'tmpfs' && typeof mount.Target === 'string') {
      targets.add(posix.normalize(mount.Target));
    }
  }
  return targets;
}

function collectBindMounts(
  createOpts: Record<string, unknown>,
): Array<{ source: string; target: string }> {
  const binds: Array<{ source: string; target: string }> = [];
  const hostConfig = (createOpts.HostConfig ?? {}) as Record<string, unknown>;
  for (const mount of asMounts(hostConfig.Mounts)) {
    if (
      mount.Type === 'bind' &&
      typeof mount.Source === 'string' &&
      typeof mount.Target === 'string'
    ) {
      binds.push({ source: mount.Source, target: mount.Target });
    }
  }
  const bindStrings = Array.isArray(hostConfig.Binds)
    ? (hostConfig.Binds as unknown[])
    : [];
  for (const entry of bindStrings) {
    if (typeof entry !== 'string') {
      continue;
    }
    const parsed = parseBindString(entry);
    if (parsed) {
      binds.push(parsed);
    }
  }
  return binds;
}

function parseBindString(
  entry: string,
): { source: string; target: string } | undefined {
  const parts = entry.split(':');
  if (parts.length < 2) {
    return undefined;
  }
  const source = parts[0];
  const target = parts[1];
  if (!source || !target) {
    return undefined;
  }
  return { source, target };
}

function applyBindMount(
  visible: Map<string, Buffer>,
  source: string,
  target: string,
): void {
  const stat = lstatSync(source);
  const normalizedTarget = posix.normalize(target);
  if (stat.isDirectory()) {
    for (const name of readdirSync(source)) {
      const child = join(source, name);
      const childStat = lstatSync(child);
      if (!childStat.isFile()) {
        continue;
      }
      visible.set(
        posix.normalize(posix.join(normalizedTarget, name)),
        readFileSync(child),
      );
    }
    return;
  }
  if (stat.isFile()) {
    visible.set(normalizedTarget, readFileSync(source));
  }
}

function coveredByMount(path: string, targets: Set<string>): boolean {
  for (const target of targets) {
    if (path === target || path.startsWith(`${target}/`)) {
      return true;
    }
  }
  return false;
}

function asMounts(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null,
  );
}
