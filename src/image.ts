const DIGEST_PINNED = /^.+@sha256:[a-f0-9]{64}$/i;

/**
 * Default runner image. Digest-pinned in code; do not use a floating tag.
 *
 * This pin is the v1 identity of `sandbox/Dockerfile`. After the first GHCR
 * publish, replace it with the registry image digest from
 * `docker buildx imagetools inspect`. Custom `image` overrides are untrusted.
 *
 * Content identity (sha256 of the runner files at v1 freeze):
 * sandbox/Dockerfile + execute.js + stream-limit.js + session-setup.js + package.json.
 */
export const DEFAULT_SANDBOX_IMAGE =
  'ghcr.io/ffp-tech-lab/ffp-sql-sandbox-runner@sha256:c5906adc35c5f67338b467aaace26cb1c3ae49f4f34a29063b55087dfb248191';

export function isDigestPinnedImage(image: string): boolean {
  return DIGEST_PINNED.test(image.trim());
}
