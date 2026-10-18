/** Default prefix keeps pi-cbm tool names distinct from pi-lens and other extensions. */
const DEFAULT_TOOL_PREFIX = "cbm_";

/** Canonical base tool names. Registered names are `${prefix}${base}`. */
export const CBM_TOOL_BASE_NAMES = [
  "search_graph",
  "resolve_symbol",
  "read_symbol",
  "get_code_snippet",
  "get_code_snippets",
  "read_symbols",
  "search_and_read_symbols",
  "trace_path",
  "get_architecture",
  "get_graph_schema",
  "query_graph",
  "search_code",
  "detect_changes",
] as const;

/** Prefix for every registered tool name. `PI_CBM_TOOL_PREFIX=""` restores the legacy names. */
export function toolPrefix(): string {
  const configured = process.env.PI_CBM_TOOL_PREFIX;
  return configured === undefined ? DEFAULT_TOOL_PREFIX : configured;
}

export function prefixedToolName(baseName: string): string {
  return `${toolPrefix()}${baseName}`;
}

/** Rewrite bare `baseNames` references inside model-facing text to their prefixed form. */
export function prefixToolReferences(text: string, baseNames: readonly string[]): string {
  const prefix = toolPrefix();
  if (!prefix) return text;
  let result = text;
  // Longest first so `read_symbols` is matched before `read_symbol`.
  for (const name of [...baseNames].sort((a, b) => b.length - a.length)) {
    result = result.replace(new RegExp(`(?<!\\w)${name}(?!\\w)`, "g"), `${prefix}${name}`);
  }
  return result;
}

export type ToolSelection = {
  /** Selected base names, or undefined when every tool is registered. */
  selected: Set<string> | undefined;
  /** `PI_CBM_TOOLS` entries that matched no base name (after prefix stripping). */
  unknown: string[];
};

/**
 * Parse `PI_CBM_TOOLS`. Entries may be bare or prefixed (`trace_path` or
 * `cbm_trace_path`). An allowlist that matches nothing falls back to every tool
 * so the extension never loads silently with zero tools; unmatched entries are
 * reported in `unknown`.
 */
export function resolveToolSelection(): ToolSelection {
  const configured = process.env.PI_CBM_TOOLS;
  if (configured === undefined) return { selected: undefined, unknown: [] };

  const prefix = toolPrefix();
  const selected = new Set<string>();
  const unknown: string[] = [];
  for (const raw of configured.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const base = prefix && entry.startsWith(prefix) ? entry.slice(prefix.length) : entry;
    if ((CBM_TOOL_BASE_NAMES as readonly string[]).includes(base)) selected.add(base);
    else unknown.push(entry);
  }

  if (selected.size === 0) return { selected: undefined, unknown };
  return { selected, unknown };
}

/** True when a base tool name is registered under the current allowlist. */
export function isBaseToolRegistered(baseName: string): boolean {
  const { selected } = resolveToolSelection();
  return !selected || selected.has(baseName);
}
