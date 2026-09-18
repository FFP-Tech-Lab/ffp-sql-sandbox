# Integrating ffp-sql-sandbox with ChuTingzj/ai-bi

This repository does **not** wire the library into [ChuTingzj/ai-bi](https://github.com/ChuTingzj/ai-bi). Keep that as a follow-up PR in ai-bi after this package is a real dependency, tests are green, and there are no P0s.

## Adapter shape

Keep NestJS, `CryptoService`, and `DataSource` inside ai-bi. Do not leak those types into this library.

Suggested adapter (ai-bi `SandboxService`):

1. Decrypt `dataSource.password` with the existing `CryptoService`.
2. Call `validateSql` / `executeSql` from `ffp-sql-sandbox`.
3. Map `{ ok: true, data }` → the current `SandboxResult` / `QueryResult` shape (`success` / `columns`+`rows`).
4. Map `{ ok: false, code, error }` → `{ success: false, error }`.

## Host rewrite stays in ai-bi

`resolveSandboxDbHost` is **not** a public export of this package (on purpose).

ai-bi may keep its private loopback → `host.docker.internal` helper for its own tests and Docker-on-Linux setups. If the adapter rewrites the host *before* calling `executeSql`, put the rewritten name on `hostAllowlist` as well.

Alternatively, pass the original host (`localhost`, `db.internal`, …) in `connection.host`, allowlist **that** name, and let this library apply a private rewrite after the allowlist check. Either way, user-controlled hosts must not bypass `hostAllowlist`.

## What not to copy from the old sandbox

| Old ai-bi behavior | v1 library |
| --- | --- |
| `DB_PASS` / password in container `Env` | Forbidden. Password goes to tmpfs `/run/secrets/db_password`. |
| `Cmd: [sql]` | SQL on stdin JSON. |
| Floating `SANDBOX_IMAGE=ai-bi-sandbox:latest` | Default image digest-pinned; custom `image` is untrusted. |
| Configurable validator prefixes/patterns | Not exposed. `validateSql(sql)` only. |
| Wait for container + `logs()` then parse/truncate | Streaming attach; `maxRows` / `maxBytes` applied as data arrives. |
| Regex as the security proof | Documented as fail-fast only. Proof is RO role + limits + allowlist. |

## Image

Build `sandbox/Dockerfile` from this repo (or pull the published digest) and configure ai-bi to use `DEFAULT_SANDBOX_IMAGE` or an explicit digest-pinned ref. Do not default to `:latest`.
