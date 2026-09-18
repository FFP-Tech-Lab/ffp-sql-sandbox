# ffp-sql-sandbox

**From First Principle** — when an LLM (or any untrusted caller) wants to run SQL, don’t trust a clever prompt. Trust a small set of checks you can name, test, and refuse to weaken.

`ffp-sql-sandbox` is a Node.js library for **read-only SQL execution with hard limits**: a fail-fast `validateSql`, plus a one-shot Docker `executeSql` that enforces resource caps, dual timeouts, streaming row/byte ceilings, and a required host allowlist.

```bash
pnpm add ffp-sql-sandbox
```

Package: [npmjs.com/package/ffp-sql-sandbox](https://www.npmjs.com/package/ffp-sql-sandbox) · Org: [FFP Tech Lab](https://github.com/FFP-Tech-Lab)

---

## Why this exists

Most “AI → SQL” stacks fail the same way: the model produces a string, something runs it, and safety is a pile of regexes plus hope. That feels productive until the first write, SSRF, or unbounded result set.

We built this library around a different bet:

1. **Name the proof.** If you can’t point at *what* stops a mutation or an unbounded read, you don’t have a sandbox — you have vibes.
2. **Keep the surface small.** Two calls. No query wizard, no schema sync, no NL layer. Host apps own product UX.
3. **Refuse soft knobs that erase the threat model.** No “just allow this DML prefix.” No password in container env. No floating `:latest` as the default trust root.

FFP Tech Lab ships primitives you can reason about. This is one of them.

---

## Design principles

| Principle | What it means here |
| --- | --- |
| Proof over ceremony | Safety claims map to concrete mechanisms (read-only DB role, container limits, streaming caps, host allowlist) — not to `validateSql` returning `{ ok: true }`. |
| Fail closed | Empty allowlist denies all. Missing Docker fails loudly. Soft “fall back to in-process SQL” is not an option. |
| Streaming limits, not post-hoc truncate | `maxRows` / `maxBytes` apply as rows arrive. Buffering the full result and then slicing is not the limits implementation. |
| Secrets stay out of `Env` | The password goes to tmpfs (`/run/secrets/db_password`). SQL rides stdin JSON. `docker inspect` should not print credentials. |
| Honest non-goals | We do not claim absolute network isolation, a full SQL AST, or that regex is authorization. |

`validateSql` is a **cheap fail-fast** for obvious writes and multi-statement junk — not the proof. Treat `{ ok: true }` as “not obviously broken,” never as “safe to run outside this sandbox.”

---

## Quick start

Docker is a **hard dependency** of `executeSql`.

```ts
import {
  validateSql,
  executeSql,
  DEFAULT_SANDBOX_LIMITS,
  DEFAULT_SANDBOX_IMAGE,
} from 'ffp-sql-sandbox'

const check = validateSql('SELECT 1')
if (!check.ok) throw new Error(check.reason)

const result = await executeSql({
  sql: 'SELECT 1 AS n',
  connection: {
    type: 'postgres', // or 'mysql'
    host: 'db.internal',
    port: 5432,
    user: 'readonly_user',
    password: process.env.DB_PASSWORD!,
    database: 'app',
  },
  hostAllowlist: ['db.internal'],
  // limits?: Partial<typeof DEFAULT_SANDBOX_LIMITS>
  // image?: string  // untrusted override; prefer DEFAULT_SANDBOX_IMAGE
})

if (!result.ok) {
  console.error(result.code, result.error)
} else {
  console.log(result.data.columns, result.data.rows)
}
```

Wire framework DI, secret decryption, and result mapping in the host — see [INTEGRATION.md](./INTEGRATION.md).

### Runner image

Default runner is on GHCR, digest-pinned as `DEFAULT_SANDBOX_IMAGE`:

```bash
docker pull ghcr.io/ffp-tech-lab/ffp-sql-sandbox-runner@sha256:13cc50f33c2d00a9ae464f3742c49a18a6b2750fdc39c23d68022476c79171a9
# convenience tags (same image): :v1 and :0.1.0 — image tags, not the npm package version
docker pull ghcr.io/ffp-tech-lab/ffp-sql-sandbox-runner:v1
```

Local build is an **untrusted** override (`image` option) — pin and review if you use it:

```bash
docker build -t ghcr.io/ffp-tech-lab/ffp-sql-sandbox-runner:v1 ./sandbox
```

---

## What actually provides the proof

| Guard | Role |
| --- | --- |
| 1. Read-only DB role | **You** connect as a read-only role (and/or `READ ONLY` transaction). The runner also prefers a read-only session and sets `statement_timeout` / `MAX_EXECUTION_TIME`. The role is still the real write barrier. |
| 2. Container limits + dual timeout | Memory, CPU, PID caps. DB timeout **and** host kill at `timeoutMs + 2000ms`. |
| 3. Streaming `maxRows` / `maxBytes` | Stop as data arrives; result may set `truncated: true`. |
| 4. `hostAllowlist` | Required. Exact match (trim, case-insensitive). Empty list → deny all. Checked **before** any container is created (SSRF). |

### Default limits

| Limit | Default |
| --- | --- |
| `timeoutMs` | `10000` |
| `memoryMb` | `128` |
| `nanoCpus` | `500000000` (0.5 CPU) |
| `maxRows` | `1000` |
| `maxBytes` | `1000000` |

### `hostAllowlist`

- Required on every `executeSql` call.
- Allowlist the host string you pass in `connection.host`.
- The library may privately rewrite loopback (`localhost`, `127.0.0.1`, …) to `host.docker.internal` *after* the allowlist check. That helper is **not** a public export.

### Default image vs custom `image`

| Image | Trust |
| --- | --- |
| `DEFAULT_SANDBOX_IMAGE` (`…@sha256:…`) | Supported, digest-pinned runner. |
| `image` override | **Untrusted.** A custom image can ignore caps or leak secrets. |

---

## Non-goals

- Natural language → SQL, guidance UIs, or schema sync
- A full SQL AST as a v1 requirement
- Multi-tenant auth / connection-pool product
- Claiming absolute network isolation (bridge networking reaches the allowlisted DB by design)
- Exporting host-rewrite helpers as public API
- Treating `validateSql` as authorization

### Known `validateSql` bypass classes (fail-fast only)

| Class | Example | Real guard |
| --- | --- | --- |
| Writes that look like `SELECT` | `SELECT … INTO …`, side-effect functions | Read-only role |
| Keyword false positives | `… WHERE action = 'UPDATE'` | Not an AST |
| Comment / encoding tricks | Leading `--`, homoglyphs | Not a parser |
| Expensive reads | `SELECT * FROM huge_table` | Timeout + streaming caps + role |
| SQL-level network | `dblink`, FDW, `LOAD_FILE` | Locked-down role (allowlist is on `connection.host`) |

---

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
| `IMAGE_UNPINNED` | `executeSql` |
| `IMAGE_UNAVAILABLE` | `executeSql` |
| `UNSUPPORTED_DIALECT` | `executeSql` |
| `EXECUTION_FAILED` | `executeSql` |

---

## Scripts

```bash
pnpm test
pnpm typecheck
pnpm build
```

---

## Release

Library (npm) and runner image (GHCR) use **separate** workflows.

### npm

Workflow: [`.github/workflows/publish-npm.yml`](./.github/workflows/publish-npm.yml).

1. Bump `version` in `package.json` (keep in sync with the git tag).
2. Repo secret **`NPM_TOKEN`**: npm granular token with publish + bypass 2FA.
3. Merge to `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z` (or `workflow_dispatch` / GitHub Release).
4. Already-published versions are skipped (no force republish).

Published versions: [npm](https://www.npmjs.com/package/ffp-sql-sandbox).

### GHCR runner

Workflow: [`.github/workflows/publish-runner.yml`](./.github/workflows/publish-runner.yml).

- Triggers on `sandbox/**` changes to `main` or `workflow_dispatch`.
- Pushes `ghcr.io/ffp-tech-lab/ffp-sql-sandbox-runner:v1` (and a convenience tag such as `:0.1.0` for the image line — **not** the npm semver).
- After a runner change, update `DEFAULT_SANDBOX_IMAGE` to the new digest from the job summary.

Org package visibility must allow public packages for anonymous `docker pull`. If pull returns unauthorized, check [org Packages settings](https://github.com/orgs/FFP-Tech-Lab/packages) and the package’s visibility.

---

## License

MIT.

---

*Built at [FFP Tech Lab](https://github.com/FFP-Tech-Lab) — From First Principle: build from fundamentals, ship with clarity.*
