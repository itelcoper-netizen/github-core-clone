[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/itelcoper-netizen/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/itelcoper-netizen/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# github-core-clone

A standalone GitHub-compatible git forge in one Node process, written for the
make.fun `github-core-clone-01` bounty. No UI, no dependencies, no disk
writes — every repository lives in memory as a git object store (blobs,
trees, commits, tags) plus refs, with the REST resources built on top.

## What it serves

- **git smart HTTP** — v0 and v2 `git-upload-pack` advertisements, `ls-refs`,
  `fetch` (with `thin-pack`, `ofs-delta`, `shallow`/`deepen`, haves/wants
  negotiation), and `git-receive-pack` pushes with fast-forward validation,
  sideband reporting, and packfiles written with plain objects.
- **REST v3** (`/api/v3`) — repos, branches, commits, git refs, file contents
  (create/update/delete with sha checks), labels, issues, comments, pull
  requests, squash merges, and `Link` pagination.
- **GraphQL v4** (`/api/graphql`) — a hand-written parser and executor for
  viewer/repository/issue/pull-request queries, cursor connections,
  introspection (`__type`, `SearchType`), mutations, and batched requests.
- **MCP** (`/mcp`) — the legacy era: `initialize`, `tools/list`,
  `tools/call` for `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The trial sets `MAKEFUN_ENV_URL`; the entry binds an ephemeral port,
registers it, and exits when the trial reports done. Without
`MAKEFUN_ENV_URL` it exits 1.

## Layout

- `main.ts` — trial lifecycle (bind, register, poll done).
- `app.ts` — HTTP server, auth, and route dispatch.
- `store.ts` — in-memory forge: git objects, refs, trees, commits, merges,
  issues, pull requests.
- `gitproto.ts` — packet lines, packfiles, v0/v2 protocol, push handling.
- `rest.ts` — REST v3 handlers and GitHub-shaped views.
- `graphql.ts` — GraphQL tokenizer, parser, and executor.
- `mcp.ts` — MCP JSON-RPC methods and tools.

## License

MIT.

Referral: https://make.fun/r/sm85re2w
