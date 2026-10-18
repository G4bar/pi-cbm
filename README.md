# pi-cbm

Pi extension that exposes [`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) as native Pi tools. `codebase-memory-mcp provides a fast local code graph. pi-cbm adds auto-indexing and adapts it for Pi agents in a way that is deliberately optimized for agent workflows and token saving.

This package does not implement an MCP client. It uses `codebase-memory-mcp cli --json <tool> <args>` and registers the core tools directly with Pi. When a Pi session starts, it automatically indexes the current git root, or a safe non-git working directory when enabled, in full mode in the background, then periodically refreshes it so graph tools stay current.

## What makes this different

- **Token-saving output by default.** Several upstream tools return rich graph metadata, fingerprints, scores, and raw analysis fields. `pi-cbm` strips less-useful metadata by default and returns compact, location-first results. Use `include_metadata: true` when you need the full upstream payload.
- **Source compaction controls.** Tools that may return code support `full_output` and `max_symbol_lines`. Normal-sized symbols are returned directly; oversized code blocks are compacted and the full uncompacted JSON is saved to a temp file.
- **Symbol-first helpers.** Upstream `cbm_get_code_snippet` works best when you already know the exact `qualified_name`. `pi-cbm` adds `cbm_resolve_symbol` and `cbm_read_symbol` so the agent can start from a normal symbol name, disambiguate with file/class/route filters, and only read source when the match is unambiguous.
- **Safe-by-default symbol reading.** `cbm_read_symbol` fails closed on ambiguity: it returns candidate identities instead of guessing and reading the wrong source. When exactly one symbol matches, it calls upstream `cbm_get_code_snippet` and can optionally include compact direct callers/callees.
- **Batch source-reading workflows.** `cbm_get_code_snippets`, `cbm_read_symbols`, and `cbm_search_and_read_symbols` let agents inspect several relevant symbols in one tool call instead of looping through many single-symbol calls. These batch tools keep the same compact metadata defaults while preserving essential locations, per-item ambiguity/error results, and source compaction controls.
- **Current project stays indexed.** On Pi session start, the extension indexes the current git root, or a safe non-git working directory when explicitly enabled, in full mode and refreshes it periodically in the background. A cross-process per-repository lease prevents duplicate indexers for one repository, while a configurable global token queue limits indexing across repositories (`PI_CBM_MAX_CONCURRENT_INDEXES`, default `1`). Root, home, system, and common builtin OS directories are never auto-indexed.
- **Project inference for cwd workflows.** Most tools accept optional `project`, but for normal current-repo work the extension infers the indexed project from Pi's current working directory.
- **Query tools only.** The agent gets code-exploration tools, not administrative controls. `index_repository` and `list_projects` are used internally for background indexing and project inference; destructive/admin MCP tools such as project deletion are not registered as Pi tools.

## Security

Pi extensions run with your local user permissions. This extension also shells out to the `codebase-memory-mcp` binary installed on your machine, so install both this package and `codebase-memory-mcp` only from sources you trust.

## Requirements: install codebase-memory-mcp

Install [`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) first. This release supports **codebase-memory-mcp 0.12.x** (`>=0.12.0 <0.13.0`); a newer minor version starts with a one-time warning, and an older one fails loudly.

These are the upstream recommended install paths.

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
```

With the optional graph visualization UI:

```sh
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash -s -- --ui
```

### Windows PowerShell

```powershell
# 1. Download the installer
Invoke-WebRequest -Uri https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile install.ps1

# 2. Optional but recommended: inspect the script
notepad install.ps1

# 3. Run it
.\install.ps1
```

Useful installer options from upstream:

- `--ui` — install the graph visualization variant.
- `--skip-config` — install the binary only, without configuring other agents.
- `--dir=<path>` — install to a custom location.

### Arch Linux AUR

```sh
yay -S codebase-memory-mcp-bin
```

or:

```sh
paru -S codebase-memory-mcp-bin
```

### Manual release archive

Download the archive for your platform from the [latest codebase-memory-mcp release](https://github.com/DeusData/codebase-memory-mcp/releases/latest):

- `codebase-memory-mcp-<platform>-<arch>.tar.gz` for macOS/Linux.
- `codebase-memory-mcp-windows-amd64.zip` for Windows.
- `codebase-memory-mcp-ui-...` variants include the graph visualization UI.

Then extract and run the included installer:

```sh
tar xzf codebase-memory-mcp-*.tar.gz
./install.sh
```

Windows PowerShell:

```powershell
Expand-Archive codebase-memory-mcp-windows-amd64.zip -DestinationPath .
.\install.ps1
```

If the binary is not on `PATH`, set:

```sh
export CODEBASE_MEMORY_MCP_BIN="$HOME/.local/bin/codebase-memory-mcp"
```

## Install

```sh
pi install npm:pi-cbm
```

Or test for one run:

```sh
pi -e npm:pi-cbm
```

To go back to the previous line, install `npm:pi-cbm@1.2.1` and use codebase-memory-mcp 0.9.x:

```sh
pi install npm:pi-cbm@1.2.1
```

## Tools

Every tool is registered with the `cbm_` prefix by default so it cannot collide with another extension (for example pi-lens registers `read_symbol`, `symbol_search`, `module_report`, `read_enclosing`, and `project_report`).

| Base name | Registered name |
| --- | --- |
| `get_graph_schema` | `cbm_get_graph_schema` |
| `get_architecture` | `cbm_get_architecture` |
| `search_graph` | `cbm_search_graph` |
| `resolve_symbol` | `cbm_resolve_symbol` |
| `read_symbol` | `cbm_read_symbol` |
| `read_symbols` | `cbm_read_symbols` |
| `search_code` | `cbm_search_code` |
| `get_code_snippet` | `cbm_get_code_snippet` |
| `get_code_snippets` | `cbm_get_code_snippets` |
| `search_and_read_symbols` | `cbm_search_and_read_symbols` |
| `trace_path` | `cbm_trace_path` |
| `query_graph` | `cbm_query_graph` |
| `detect_changes` | `cbm_detect_changes` |

### Tool name prefix and allowlist

- `PI_CBM_TOOL_PREFIX` overrides the prefix. Set it to an empty string to restore the legacy unprefixed names (upstream compatibility). Legacy names collide with pi-lens (`read_symbol`, `symbol_search`), and Pi refuses to load two extensions that register the same tool name, so do not use an empty prefix alongside pi-lens.
- `PI_CBM_TOOLS` is an optional comma-separated allowlist of base names (bare or `cbm_`-prefixed). When set, only those tools are registered; unset (or empty) registers all 13. Unknown entries are ignored with a warning, and an allowlist that matches nothing falls back to all tools. Use it to cut tool-description tokens in sessions that allow everything.
- `PI_CBM_SKIP_VERSION_CHECK=1` disables the `codebase-memory-mcp --version` probe and its compatibility warning.

Most tools accept optional `project`. When omitted, the extension infers it from indexed project roots matching Pi's current working directory. Agents should omit `project` for cwd/current-project work and provide it only when intentionally querying an external indexed project. A `project` value must be an indexed project name or a path (absolute, or relative to the current working directory); an unknown value fails with the indexed project list instead of falling back to a guessed name.

Matching uses the longest indexed root that contains the working directory, so a git worktree or nested checkout that is not indexed itself resolves to the containing repo's graph. Index the worktree separately to query its own graph.

## Commands

### `/cbm`

Open the pi-cbm settings menu:

- `/cbm menu` — show the interactive settings menu.
- `/cbm status` — show auto-index settings.
- `/cbm enable-non-git` — auto-index safe non-git working directories.
- `/cbm disable-non-git` — only auto-index git repositories.

Non-git auto-indexing is disabled by default. Enable it explicitly when working in a non-git project. The unsafe-path guard is always enabled: filesystem roots, home directories, system directories, and common macOS/Linux builtin directories are skipped with a status message explaining why.

Set `PI_CBM_MAX_CONCURRENT_INDEXES` to configure the machine-wide maximum number of simultaneous repository indexers. It defaults to `1`; use a higher value only when all Pi sessions share the same cache directory and the machine can safely support the additional concurrency.

Set `PI_CBM_AUTO_REFRESH_INTERVAL_MS` to override the background refresh interval in milliseconds. It defaults to `60000` (60 seconds), so single-agent workflows do not have to wait for a long freshness TTL. `PI_CBM_CACHE_DIR` optionally overrides the coordination/cache directory and is forwarded to the upstream CLI as `CBM_CACHE_DIR`.

The legacy `CBM_MAX_CONCURRENT_INDEXES`, `CBM_AUTO_REFRESH_INTERVAL_MS`, and `CBM_CACHE_DIR` names remain supported for backwards compatibility. When both names are set, the `PI_CBM_*` value takes precedence.

Notes:

- Use `cbm_search_graph` first for symbol/workflow/route/class/function discovery and “where is X implemented?” questions. Use a small limit for targeted lookup.
- Use `cbm_search_and_read_symbols` when you need to both discover implementation locations and inspect source for the top matches. Prefer it over `cbm_search_graph` followed by many individual snippet reads. Keep `read_limit` small, usually 3–8.
- Use `cbm_resolve_symbol` when you know a symbol name but need the exact `qualified_name` or need to disambiguate candidates.
- Use `cbm_read_symbol` when you know a symbol name plus enough disambiguators, such as `file_path`, `parent_class`, `label`, `route_path`, or `route_method`, and want source only if the match is unambiguous.
- Use `cbm_read_symbols` when you know multiple concrete symbol names and need their source in one call. Each item fails closed on ambiguity like `cbm_read_symbol`; retry only ambiguous items with stronger disambiguators.
- `cbm_read_symbol` fails closed on ambiguity; if it returns candidates, retry with more disambiguators or use `cbm_get_code_snippet` with an exact `qualified_name`.
- `cbm_read_symbol` supports `neighbors: "callers" | "callees" | "both"` plus `neighbor_limit` for direct, compact, source-free surrounding call context. Use `cbm_trace_path` for multi-hop workflow or impact tracing.
- Use `cbm_get_code_snippet` when you already have an exact `qualified_name`; prefer `cbm_read_symbol` when you have a concrete symbol name plus disambiguators but not the exact `qualified_name`.
- Use `cbm_get_code_snippets` when you already have multiple exact `qualified_name` values from search, trace, or query results. Prefer it over repeated `cbm_get_code_snippet` calls.
- If the query is a symbol name, prefer `cbm_resolve_symbol`/`cbm_read_symbol`; if it is an exact non-symbol string or you need all textual occurrences, use `cbm_search_code`.
- Use `cbm_search_code` for exact literal text/regex searches such as env vars, config keys, route strings, error messages, constants, template text, comments, and docstrings.
- Use `cbm_trace_path` after identifying an anchor symbol when you need callers, callees, workflow, dependency, data-flow, or blast-radius context. Keep depth shallow by default.
- Use `cbm_get_code_snippet` only after `cbm_search_graph`/`cbm_search_code` identifies the exact symbol. Keep snippet retrieval targeted instead of bulk-reading many symbols.
- Use `cbm_get_architecture` for broad orientation in unfamiliar repos, not targeted implementation lookup. Requested aspects may be absent if the index has no data for them.
- Use `cbm_get_graph_schema` before non-trivial `cbm_query_graph` queries, and keep `cbm_query_graph` returned columns narrow.
- Use `cbm_detect_changes` for diff review or blast-radius analysis, not ordinary code lookup.
- Read obvious README/package/deployment/config manifest paths directly instead of forcing graph tools into file-inspection work.
- `cbm_trace_path` auto-resolves short function/method names when there is a single unambiguous match; otherwise it returns candidate `qualified_name`s. It also supports explicit plugin-side `exclude_paths` filters.
- Exploration tools such as `cbm_search_graph`, `cbm_get_code_snippet`, `cbm_trace_path`, `cbm_get_architecture`, `cbm_search_code`, and `cbm_detect_changes` default to compact, location-first output. Less-useful upstream graph metadata such as fingerprints, token fields, and raw metrics is hidden unless `include_metadata: true` is set.
- Batch/source tools such as `cbm_get_code_snippets`, `cbm_read_symbols`, and `cbm_search_and_read_symbols` use the same compact metadata defaults: they preserve essential identity such as `file_path`, `start_line`, `end_line`, `qualified_name`, signatures, and route fields while stripping less-useful raw graph metadata unless `include_metadata: true` is set.
- Compact output hides analysis metadata, not edit-critical location identity. Symbol-like outputs preserve `file_path`, `start_line`, and `end_line` when available, and the plugin enriches missing locations for resolver, trace, and architecture outputs where possible.
- Code/source-heavy tools support `full_output` and `max_symbol_lines`. By default, normal-sized symbols are returned in full and only oversized function/method/class-sized blocks are compacted.
- `cbm_search_code` defaults to compact output with small context to avoid flooding the agent context, and oversized per-symbol contexts are compacted unless `full_output=true` or `max_symbol_lines` is increased. If a result is compacted/truncated, agents should retry the same codebase-memory tool with a higher `max_symbol_lines` or `full_output=true` before falling back to file reads/grep.
- `cbm_query_graph` normalizes common numeric metric columns in the returned rows for easier agent consumption, while still relying on upstream for query execution/order.

## Index freshness

When a Pi session starts, the extension indexes the current git root in the background and refreshes it on the `PI_CBM_AUTO_REFRESH_INTERVAL_MS` interval. `cbm_detect_changes` additionally forces a bounded re-index when the project's index is older than a few seconds, because CLI-mode cbm indexes are not watched and a stale graph silently omits impacted symbols after an edit. If that refresh cannot run, the tool reports the reason instead of hiding it.

## Typical workflow

Ask Pi:

```text
Give me the architecture overview.
```

The extension indexes and periodically refreshes the current repo in the background, so the agent should usually go straight to `cbm_get_architecture`, `cbm_search_graph`, `cbm_get_code_snippet`, `cbm_trace_path`, `cbm_search_code`, or `cbm_query_graph` for structural code exploration. Administrative index operations remain available through the `codebase-memory-mcp` CLI when needed.
