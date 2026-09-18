# Integrating ffp-sql-sandbox

This repository ships **library primitives only**. It does not embed a product UI, Nest module, or connection catalog. Wire `validateSql` / `executeSql` in the host application after this package is a real dependency, tests are green, and there are no P0s.

## Adapter shape

Keep framework DI, secret decryption, and ORM / data-source types in the host app. Do not leak those types into this library.

Suggested host adapter:

1. Decrypt the database password with the host app’s secret store.
2. Call `validateSql` / `executeSql` from `ffp-sql-sandbox`.
3. Map `{ ok: true, data }` → the host app’s query-result shape (`success` / `columns`+`rows`).
4. Map `{ ok: false, code, error }` → `{ success: false, error }`.

## Host rewrite stays in the caller

`resolveSandboxDbHost` is **not** a public export of this package (on purpose).

The host app may keep a private loopback → `host.docker.internal` helper for its own tests and Docker-on-Linux setups. If the adapter rewrites the host *before* calling `executeSql`, put the rewritten name on `hostAllowlist` as well.

Alternatively, pass the original host (`localhost`, `db.internal`, …) in `connection.host`, allowlist **that** name, and let this library apply a private rewrite after the allowlist check. Either way, user-controlled hosts must not bypass `hostAllowlist`.

## What not to copy from a naive Docker sandbox

| Naive sandbox | v1 library |
| --- | --- |
| Password in container `Env` (`DB_PASS`, `PGPASSWORD`, …) | Forbidden. Password goes to tmpfs `/run/secrets/db_password`. |
| `Cmd: [sql]` | SQL on stdin JSON. |
| Floating image tag (`:latest`) | Default image digest-pinned; custom `image` is untrusted. |
| Configurable validator prefixes/patterns | Not exposed. `validateSql(sql)` only. |
| Wait for container + `logs()` then parse/truncate | Streaming attach; `maxRows` / `maxBytes` applied as data arrives. |
| Regex as the security proof | Documented as fail-fast only. Proof is RO role + limits + allowlist. |

## Image

Build `sandbox/Dockerfile` from this repo (or pull the published digest) and configure the host app to use `DEFAULT_SANDBOX_IMAGE` or an explicit digest-pinned ref. Do not default to `:latest`.
