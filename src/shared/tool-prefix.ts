/** Default prefix keeps pi-cbm tool names distinct from pi-lens and other extensions. */
const DEFAULT_TOOL_PREFIX = "cbm_";

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
