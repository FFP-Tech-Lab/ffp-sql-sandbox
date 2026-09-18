# ffp-sql-sandbox

Read-only SQL sandbox primitives for Node.js: fail-fast `validateSql` plus one-shot Docker `executeSql` with hard resource, row, byte, timeout, and host-allowlist limits.

This is the v1 library extracted from the sandbox ideas in [ChuTingzj/ai-bi](https://github.com/ChuTingzj/ai-bi) (`validateSql` + dockerode one-shot container) and redesigned around a stricter security model. It is **not** wired into ai-bi in this repository — see [INTEGRATION.md](./INTEGRATION.md).

## Install

```bash
pnpm add ffp-sql-sandbox
```

Docker is a **hard dependency** of `executeSql`. If the engine cannot be pinged, the call fails with `DOCKER_UNAVAILABLE` rather than falling back to in-process SQL.

Build the runner image from `sandbox/Dockerfile` (digest-pinned `FROM`) and either publish it at the default ref below or pass `image` (untrusted override).

```bash
docker build -t ghcr.io/ffp-tech-lab/ffp-sql-sandbox-runner:v1 ./sandbox
```

## Public API

```ts
import {
  validateSql,
  executeSql,
  DEFAULT_SANDBOX_LIMITS,
  DEFAULT_SANDBOX_IMAGE,
} from 'ffp-sql-sandbox'

validateSql(sql: string): { ok: true } | { ok: false; code: string; reason: string }

executeSql(input: {
  sql: string
  connection: {
    type: 'postgres' | 'mysql'
    host: string
    port: number
    user: string
    password: string  // never placed in container Env
    database: string
  }
  hostAllowlist: string[]  // required
  limits?: Partial<SandboxLimits>
  image?: string  // untrusted override; default image is digest-pinned
}): Promise<
  | { ok: true; data: { columns: string[]; rows: unknown[][]; truncated?: boolean } }
  | { ok: false; code: string; error: string }
>
```

`validateSql` is fail-fast only. There are no `allowPrefixes` / `forbidPatterns` options.

`resolveSandboxDbHost` is **not** exported. Loopback rewrite for container DNS, if needed, stays private (and, for ai-bi, in the adapter — see INTEGRATION.md).

## Non-goals

- Natural language → SQL, query guidance, schema sync, or an AST parser as a required v1 component
- A multi-tenant auth / connection-pool product
- Claiming absolute network isolation (the runner uses Docker `bridge` so it can reach the allowlisted database)
- Exporting `resolveSandboxDbHost` as public API
- Making `validateSql` a proof of safety (it is a cheap reject, not a guarantee)

## Threat model

Proof that a query cannot mutate data or exfiltrate unbounded results does **not** come from regex. v1 proof is the combination of:

| Guard | What it actually does |
| --- | --- |
| 1. Read-only DB role | **Caller must connect as a read-only role** (and/or a `READ ONLY` transaction). The library also sets `statement_timeout` and *prefers* a read-only session (`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` on Postgres, `SET SESSION TRANSACTION READ ONLY` on MySQL) when the dialect allows it. If that `SET` is ignored or the role can override it, the database role is still the real write barrier. |
| 2. Container limits + dual timeout | Memory, nano-CPUs, PID cap, dropped capabilities. **Dual timeout**: the runner sets DB `statement_timeout` / `MAX_EXECUTION_TIME` to `timeoutMs`, and the host kills the container after `timeoutMs + 2000ms` if it is still running. |
| 3. Streaming `maxRows` / `maxBytes` | The runner applies limits **as rows arrive** and stops/cancels instead of buffering the full result. The host consumer is a backstop on the live Docker attach stream. **Demux-then-truncate of a completed log buffer is not the limits implementation.** |
| 4. `connection.host` allowlist | SSRF defense. `hostAllowlist` is required. Hosts not on the list are rejected **before** any container is created. No arbitrary hosts, no glob, no CIDR in v1 — exact match after trim + case-insensitive compare. |

Passwords are written to a **tmpfs** file at `/run/secrets/db_password` inside the container (mode/uid for the `node` user). They are **never** placed in container `Env` (no `DB_PASS`, `PGPASSWORD`, or `MYSQL_PWD`). SQL is sent on stdin JSON, not `Cmd`, so `docker inspect` does not show the password.

### Default image vs custom image

| Image | Trust |
| --- | --- |
| `DEFAULT_SANDBOX_IMAGE` (`…@sha256:…`) | Digest-pinned default. Treat as the supported runner. |
| `image` override | **Untrusted.** Allowed so callers can build locally, but a custom image can ignore streaming caps, log secrets, or exfiltrate. Pin and review your own image if you override. |

The Dockerfile `FROM` line is also digest-pinned (`node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`).

Until GHCR publish, `DEFAULT_SANDBOX_IMAGE` is a **content digest** of the v1 runner files, not a registry-pullable image. `executeSql` without `image` will return `IMAGE_UNAVAILABLE` if that digest is not present locally. Build `sandbox/Dockerfile` and pass `image` (untrusted override), or `docker load` / retag the digest-pinned image. After the first registry push, replace the constant with `docker buildx imagetools inspect` output.

## Default limits

| Limit | Default | Role |
| --- | --- | --- |
| `timeoutMs` | `10000` | DB `statement_timeout` / `MAX_EXECUTION_TIME`, plus container kill at `timeoutMs + 2000` |
| `memoryMb` | `128` | Container memory (and memory-swap) cap |
| `nanoCpus` | `500000000` (0.5 CPU) | Container CFS quota |
| `maxRows` | `1000` | Streaming row cap; result may set `truncated: true` |
| `maxBytes` | `1000000` | Streaming serialized-row / stdout byte cap; result may set `truncated: true` |

## `hostAllowlist` contract

- Required on every `executeSql` call.
- Empty list → `HOST_NOT_ALLOWED` (deny all).
- Compared against the **caller-supplied** `connection.host` (trimmed, case-insensitive). The library may rewrite loopback (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) to `host.docker.internal` *after* the allowlist check so the container can reach a DB on the Docker host. That rewrite is private and not a public API.
- Put the host you actually pass in on the list (e.g. `db.internal` or `localhost`). Do not accept user-controlled hosts without your own allowlist.

## `validateSql` is fail-fast only (known bypasses)

`validateSql` is a cheap prefix + keyword + multi-statement reject. **Do not treat a `{ ok: true }` as authorization to run SQL outside this sandbox.** Known classes:

| Class | Example | Notes |
| --- | --- | --- |
| Writes that still look like `SELECT` | `SELECT … INTO …`, `SELECT pg_file_write(...)` | Prefix allowlist does not model Postgres side effects. **Read-only role** is the guard. |
| False positives | `SELECT * FROM t WHERE action = 'UPDATE'` | Keyword scan is not an AST. Fail-fast, not completeness. |
| Comment / encoding tricks | Leading `--` comments, Unicode homoglyphs | Rejected or missed; not a parser. |
| Expensive reads | `SELECT * FROM huge_table` | Allowed by regex; stopped by timeout + `maxRows`/`maxBytes` + role. |
| Multi-statement via protocol | Driver-level stacked queries if the runner used a naive exec | Runner sends a single query text; DB role + `READ ONLY` still apply. |
| Network | `dblink`, `http` FDW, `LOAD_FILE` | Allowlist is on `connection.host`, not on SQL-level network functions. Use a locked-down role. |

## Error codes

| Code | Where |
| --- | --- |
| `NOT_READ_ONLY_PREFIX` | `validateSql` / `executeSql` |
| `FORBIDDEN_KEYWORD` | `validateSql` / `executeSql` |
| `MULTI_STATEMENT` | `validateSql` / `executeSql` |
| `HOST_NOT_ALLOWED` | `executeSql` |
| `DOCKER_UNAVAILABLE` | `executeSql` |
| `TIMEOUT` | `executeSql` |
| `INVALID_LIMITS` | `executeSql` |
| `IMAGE_UNPINNED` | `executeSql` (default image missing digest) |
| `IMAGE_UNAVAILABLE` | `executeSql` (image missing locally / not pullable; default digest is unpublished until GHCR) |
| `UNSUPPORTED_DIALECT` | `executeSql` |
| `EXECUTION_FAILED` | `executeSql` |

## Scripts

```bash
pnpm test       # node:test via tsx
pnpm typecheck
pnpm build
```

## License

MIT. The GitHub repository may stay private until the org publishes it; that does not change the source license.
