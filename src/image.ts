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
  'ghcr.io/ffp-tech-lab/ffp-sql-sandbox-runner@sha256:57767f4e80e9f5c6066eeaf996f3101c7ce4ea2740538c06523eeaaf0b15feb6';

export function isDigestPinnedImage(image: string): boolean {
  return DIGEST_PINNED.test(image.trim());
}
