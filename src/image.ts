const DIGEST_PINNED = /^.+@sha256:[a-f0-9]{64}$/i;

/**
 * Default runner image. Digest-pinned in code; do not use a floating tag.
 *
 * This pin is the v1 identity of `sandbox/Dockerfile`. It is **not** a
 * GHCR-pullable digest until the runner is published. `executeSql` without
 * `image` returns `IMAGE_UNAVAILABLE` if Docker cannot find it. After the
 * first GHCR publish, replace this with `docker buildx imagetools inspect`.
 * Custom `image` overrides are untrusted.
 *
 * Content identity (sha256 of the runner files at this freeze):
 * sandbox/Dockerfile + execute.js + stream-limit.js + session-setup.js +
 * secrets.js + events.js + package.json.
 */
export const DEFAULT_SANDBOX_IMAGE =
  'ghcr.io/ffp-tech-lab/ffp-sql-sandbox-runner@sha256:861dd5eb53f5c3eb468b73b6068385f0688910fc10ba68610d20bb3de9f78952';

export function isDigestPinnedImage(image: string): boolean {
  return DIGEST_PINNED.test(image.trim());
}
