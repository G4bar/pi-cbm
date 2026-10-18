# cbm CLI contract fixtures

Raw output captured from two `codebase-memory-mcp` (cbm) builds by
`scripts/capture-fixtures.sh <binary> <version>`, against a neutral copy of this
fork's own `src/` (no private paths). Later phases read this file instead of
re-capturing.

- `cbm-0.12.1/` — 54 files, captured from cbm 0.12.1.
- `cbm-0.9.0/` — 48 files, captured from cbm 0.9.0.

## Fixture file format

Per case, two files:

- `<tool>.<case>.json` — **raw stdout, verbatim**. A JSON envelope when the tool
  returned JSON, plain tree text for the `*.tree` / `stdin-format-ignored` cases.
- `<tool>.<case>.meta.json` — `{ invocation, args_json, exit_code, duration_ms, stderr }`.

Captured against project `tmp-cbm-fixture-repo` (cbm names a project from its
absolute path: leading `/` dropped, `/` -> `-`), qn
`tmp-cbm-fixture-repo.src.cbm.client.CbmClient.callTool`.

## Baseline (upstream 1.2.1, before any change)

| command | result |
| --- | --- |
| `npm install` | ok |
| `npm run typecheck` (`tsc --noEmit`) | pass, exit 0 |
| `npm test` (`vitest run`) | pass: 3 files, 35 tests |

## Answers

**Version string format.** `codebase-memory-mcp --version` prints
`codebase-memory-mcp 0.12.1\n` (resp. `0.9.0`) on stdout, empty stderr, exit 0.
Parse with a `codebase-memory-mcp <semver>` match. Do **not** use the `version`
subcommand (0.12 prints nothing; 0.9 actually starts the MCP server) or
`cli --version` (exit 1, `unknown tool: --version`).

**list_projects JSON availability.** Yes, both versions, but 0.12 has a trap:
with args on **stdin**, `format` is ignored and the tool returns tree text
(`list_projects.stdin-format-ignored.json`). JSON only comes from the
`--format json` flag (`list_projects.format-flag.json`) or a positional
argv JSON (`list_projects.inline-args.json`). Tree text shape:
`projects: N  (cols: name root_path branch)\n  <name> <root_path> <branch>\ntotal: N\nreturned: N\nhas_more: false\n`.
0.12 JSON is flat (`{projects:[{name,root_path,branch}],total,offset,limit,returned,has_more}`);
0.9.0 is always JSON with a rich `git` block per project (no tree form).

**stdin accepted with `cli --json`.** Yes on both: `printf '<json>' | <bin> cli --json <tool>`
returns the normal envelope. 0.12 additionally warns on stderr that a raw JSON
argv is deprecated (`list_projects.inline-args.meta.json`).

**Error envelope shapes.** All errors are
`{"content":[{"type":"text","text":...}],"isError":true}`. `text` is a bare
string (not JSON) for `get_code_snippet` unknown qn
(`symbol not found. Use search_graph(name_pattern="...") first ...`); other
errors are JSON objects with `error` + `hint` (+ `available_projects` for an
unknown project). 0.12 also adds `structuredContent.error`, and exits **1** on
`isError`; 0.9.0 always exits **0**.

**No-change re-index seconds.** 0.12.1 ≈ **1.2 s**, 0.9.0 ≈ **0.11 s** (second
full `index_repository` on an unchanged repo; both still report
`status: "indexed"`). Wall time of every 0.12 CLI call is ≈2 s, so those 1.2 s
are dominated by CLI startup, not by re-parsing.

**`labels(n)` aggregate correct on 0.12?** Yes. `MATCH (n) RETURN labels(n), count(n)`
on 0.12.1 returns the same counts as `get_architecture` `node_labels`
(Function 130, Method 61, Variable 58, Type 36, File 26, Module 26, EnvVar 9,
Class 8, Folder 6, Process 2, Branch 1, Interface 1, Project 1). Counts are
strings, not numbers. On 0.9.0 the aggregate is broken
(`[["363","363"]]`, single row). No tool-description warning is needed for 0.12.

**Does `fields` add `start_line`/`signature`?** Partly. On 0.12 only,
`search_graph` accepts `fields: ["signature","parent_class","start_line","end_line"]`
and appends those columns. `signature` and `parent_class` are populated;
`start_line`/`end_line` are added but **null** — the line range exists only in
the `lines` string column (`"43-100"`). 0.9.0 ignores `fields` (it already
returns `signature`/`parent_class` per object, plus a `lines` count, no line range).

**Do `index_status`/watch keep CLI-mode indexes fresh?** No.
`index_status.watch = {watched:false, reason:"not_session_project", hint:"Auto-sync
watches only the active MCP session's project; re-run index_repository to refresh
this index."}`. One-shot CLI calls must re-index; only an active MCP session gets
auto-sync. 0.12 also exposes `index_repository --status` and `--async`
(`index_repository.help.json`). 0.9.0 `index_status` has no `watch` block.

## Other contract differences (0.9.0 -> 0.12.1)

- `search_graph`: 0.9.0 returns `{total, results:[{name,qualified_name,label,file_path,in_degree,out_degree,...}]}`;
  0.12 returns `{qn_rule, cols, groups:[{qn_prefix, file, rows:[[...]]}], total, returned, count, has_more, truncated}`.
  `qualified_name` must be composed from `qn_prefix` + row `name`.
- `trace_path`: 0.9.0 `callers`/`callees` are object arrays with `qualified_name`/`name`/`hop`;
  0.12 returns the same `groups`/`cols:["name","hop"]` table shape (plus `callers_total`).
- `search_code`: 0.9.0 `results:[{node,qualified_name,label,file,start_line,end_line,match_lines,context}]`;
  0.12 `cols`/`rows` with `qn,label,file,lines,matches,matches_omitted,in,out,context`.
- `search_code` paging: 0.12 has no `offset` flag/key; results page with `result_offset`
  (CLI `--result-offset`; `--result-limit`, `--raw-offset`/`--raw-limit`,
  `--directory-offset`/`--directory-limit`, `--match-limit` are the other page flags).
  A bare `offset` JSON key is silently ignored: live on 0.12.1
  `{"offset":2}` returned page 0, while `{"result_offset":2}` moved the page. The pi
  tool keeps the agent-facing `offset` and translates it to `result_offset` before
  the CLI call (`QueryService.upstreamSearchCodeParams`).
- `get_architecture.node_labels`: 0.9.0 array of `{label,count}`; 0.12 `{cols,rows}`.
- `get_code_snippet`: 0.12 adds `source_mode`; both always report numeric
  `callers`/`callees` counts, and `include_neighbors: true` adds
  `caller_names`/`callee_names` (0.12; 0.9.0 adds `callee_names` only).
- `detect_changes`: 0.12 returns `changed_files` + `impacted[]` (`qn,label,file,hop`);
  0.9.0 returns `changed_files`/`changed_count`/`impacted_symbols[]` and lists the
  changed file twice.
- `search_graph.qn_pattern` is a regex on 0.12 (`*client*` -> `invalid regex`); use `.*client.*`.
- Unknown-project hint text differs between versions (both list `available_projects`).
- 0.9.0 needs the cache directory to exist before the first call
  (`cannot read cache directory: <dir>` otherwise); 0.12 creates it.
- 0.9.0 writes `level=info msg=mem.init ...` to stderr on every call; 0.12 does not.

## Normalized shapes (phase 2 `normalizeCbmData`)

`CbmClient.callTool` runs every parsed result through `normalizeCbmData`, so 0.12
compact tables reach domain consumers as object arrays:

- `search_graph`, grouped **and** flat `query:` tables: an object with the paging
  meta preserved (`total`, `has_more`, `truncated`, `returned`, `next_offset`, ...)
  and the expanded rows under `results`.
- `search_code`: an object with its meta preserved (`total_results`, `has_more`,
  ...) and the expanded rows under `results`.
- `trace_path` `callers`/`callees`: bare arrays (no `results` wrapper).
- `get_architecture` `node_labels`/`edge_types`/`languages`/`packages`/`entry_points`:
  bare arrays; a `{cols, rows}` table with no sibling keys always collapses to an array.
- `query_graph` `{columns, rows}`: untouched (still consumed by `coerceQueryGraphMetrics`).
- Expanded rows get aliases: `qn`->`qualified_name`, `file`->`file_path` (both kept),
  `lines` "a-b" -> numeric `start_line`/`end_line`, `in`/`out` -> `in_degree`/`out_degree`,
  `matches` -> `match_lines`. `null` source cells are not aliased.

Phase 4/5 consumers should read `data.results` for `search_graph` and `search_code`.

## Reproducing / refreshing

```sh
# neutral fixture repo (project name tmp-cbm-fixture-repo)
rm -rf /tmp/cbm-fixture-repo && mkdir -p /tmp/cbm-fixture-repo
cp -r src /tmp/cbm-fixture-repo/src
git -C /tmp/cbm-fixture-repo init -q && git -C /tmp/cbm-fixture-repo add -A
git -C /tmp/cbm-fixture-repo -c user.email=fixture@example.com -c user.name=fixture commit -qm fixture

# capture (per binary; resets the fixture repo, then dirties one file for detect_changes)
scripts/capture-fixtures.sh /tmp/cbm0121/codebase-memory-mcp 0.12.1
scripts/capture-fixtures.sh /tmp/cbm090/codebase-memory-mcp 0.9.0

npm run typecheck && npm test
```

Safety: the script always points `CBM_CACHE_DIR` at a fresh temp dir. The real
cache (`$HOME/.cache/codebase-memory-mcp`) must be byte-identical before and
after a capture run — check with `ls -la` on that directory (this is the
regression check for a new cbm release too).

## How to refresh fixtures for a new cbm release

```sh
scripts/capture-fixtures.sh /path/to/codebase-memory-mcp 0.13.0
diff -ru test/fixtures/cbm-0.12.1 test/fixtures/cbm-0.13.0
npm run typecheck && npm test
```

Read the diff, do not just check the exit code: a changed `cols`/`groups`/
`isError` shape is a contract change that `src/cbm/normalize.ts` and its domain
consumers must absorb, while new meta keys or different counts are usually
noise. When the shapes did change, update the answers below, the range in
`src/cbm/version.ts`, and the version table at the top of this file, then run
the live smoke (`npm run smoke:live`, below) before deleting the old fixtures
directory. Check the real cache before and after, as in the safety note above.

## Live smoke against a real binary

`npm run smoke:live` drives the extension's own services (`CbmClient`,
`ProjectService`, the domain services) against a real binary through indexing,
search, symbol resolution/reading, trace paths, queries and `detect_changes`.
It is opt-in — vitest never runs it — and exits 0 with `SKIP` when `CBM_BIN` is
unset.

```sh
CBM_BIN=/tmp/cbm0121/codebase-memory-mcp CBM_BIN_OLD=/tmp/cbm090/codebase-memory-mcp npm run smoke:live
```

`CBM_BIN_OLD` is optional; with it, the last check asserts the older binary
fails with the too-old error. The script creates a temp cache dir and a temp
`src/` copy of this repo, points `CBM_CACHE_DIR` at the former and deletes both
at the end, so the real cache must stay unchanged.

### The 0.12 background daemon

0.12.x starts a background `codebase-memory-mcp --cbm-daemon-internal` on the
first CLI call. Observed on 0.12.1 (linux-amd64):

- One daemon per cache dir, with that dir's own `<project>.db` files; two runs
  with different temp `CBM_CACHE_DIR`s did not share state (checked while
  writing the smoke test, no cross-talk seen).
- It outlives the CLI call by a few seconds before idle shutdown, and
  re-creates its cache dir if that dir is deleted, so a bare `rm -rf` of the
  temp dir can leave an empty `cache/` behind.
- 0.12.1 has no `daemon` subcommand (`--help` lists only
  install/uninstall/update/config), so the smoke script stops it itself: it
  records the `--cbm-daemon-internal` PIDs before the run, then `SIGTERM`s the
  new ones only, and only when `/proc/<pid>/environ` reports this run's own
  `CBM_CACHE_DIR`.

