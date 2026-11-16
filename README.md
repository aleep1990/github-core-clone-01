# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/aleep1990/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/aleep1990/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, built for make.fun's
["Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01)
bounty: git smart HTTP (clone/push, protocol v2 + v0), REST v3, GraphQL v4 and
MCP over streamable HTTP, on one hand-rolled in-memory object store. No
dependencies, no git binary at runtime, no outside service, no model calls —
every byte it serves is deterministic.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing
to install: the program imports `node:http` and its own sources only, and the
trial has no package manager and no internet. The lifecycle (`main.ts`) binds
an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, polls `/done` and
exits 0 — keep it as it is.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 ls-refs/fetch, v0 fetch), `git-receive-pack` (v0). Undeltified v2 packs, incremental fetch sends exactly the newly reachable objects, shallow/deepen supported, non-fast-forward refused with `non-fast-forward` |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents (real git commits), issues, comments, labels, pull requests, squash merges. Exact statuses, `X-GitHub-Request-Id` on every reply, JSON never HTML, Link pagination |
| `POST /api/graphql` | GitHub GraphQL v4: hand-rolled parser + executor, introspection, opaque stable global ids, cursor pagination, same-store mutations |
| `POST /mcp` | Model Context Protocol over streamable HTTP (2026-07-28 `server/discover` + legacy `initialize`): 6 tools — create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request |
| anything else | 404 `{"message":"Not Found"}` |

## Determinism

No wall clock, no randomness anywhere in a response: every timestamp comes
from `MAKEFUN_TRIAL_NOW` (fallback `2026-11-14T06:30:00.000Z`), fixture commit
epochs from `SCENARIO_EPOCH_SEC` plus a per-repo sequence, request ids from a
counter. Two runs leave byte-identical state.

## Layout

- `main.ts`: the entry <-> env lifecycle. Keep it as it is.
- `app.ts`: the server — routing only, with a never-crash guard.
- `src/store.ts`: the in-memory store (viewer `adaiversen`, id 1000) and the deterministic clock.
- `src/gitobj.ts`: SHA-1 object ids, commit/tree/tag parsing, reachability.
- `src/pack.ts`: pack v2 write (undeltified) + read with delta-apply.
- `src/pktline.ts`: pkt-line framing and sideband.
- `src/smart.ts`: git smart HTTP.
- `src/rest.ts`: REST v3 (27 endpoints).
- `src/graphql.ts`: GraphQL v4.
- `src/mcp.ts`: MCP (hand-rolled JSON-RPC 2.0).
- `src/http.ts`: shared body reading, JSON/raw replies, Bearer auth.
- `tests/`: smoke tests per surface plus a cross-surface integration test
  (real `git` binary for push/clone round-trips, testing only).

## Tests

```sh
node --experimental-strip-types tests/core-test.mjs
node --experimental-strip-types tests/smart-test.mjs
node --experimental-strip-types tests/rest-test.mjs
node --experimental-strip-types tests/graphql-test.mjs
node --experimental-strip-types tests/mcp-test.mjs
node --experimental-strip-types tests/integration-test.mjs
```

All six suites pass on Node 22.18.0 (152 checks total).

---

<sub>Entered on [make.fun](https://make.fun/?ref=8j2bwr3r&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
