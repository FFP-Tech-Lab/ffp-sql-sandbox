const DIGEST_PINNED = /^.+@sha256:[a-f0-9]{64}$/i;

/**
 * Default runner image. Digest-pinned in code; do not use a floating tag.
 *
 * Published to GHCR as `ghcr.io/ffp-tech-lab/ffp-sql-sandbox-runner`
 * (`:v1`, `:0.1.0`, and this digest). `executeSql` without `image` returns
 * `IMAGE_UNAVAILABLE` if Docker cannot pull or find it. Custom `image`
 * overrides are untrusted.
 */
export const DEFAULT_SANDBOX_IMAGE =
  'ghcr.io/ffp-tech-lab/ffp-sql-sandbox-runner@sha256:13cc50f33c2d00a9ae464f3742c49a18a6b2750fdc39c23d68022476c79171a9';

export function isDigestPinnedImage(image: string): boolean {
  return DIGEST_PINNED.test(image.trim());
}
