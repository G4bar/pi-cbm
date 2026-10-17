import { toolPrefix } from "../shared/tool-prefix.js";

/**
 * Division of labor between the code graph (`cbm_*`) and file-level code tools.
 * Built with the configured prefix so an empty `PI_CBM_TOOL_PREFIX` reads as legacy names.
 */
export function codebaseMemoryPrompt(): string {
  const p = toolPrefix();
  const graph = `${p}*`;
  return `

Codebase-memory guidance:
- \`${graph}\` tools read the code graph: cross-file structure, callers/callees (\`${p}trace_path\`), blast radius (\`${p}detect_changes\`), architecture (\`${p}get_architecture\`), and finding implementations by meaning (\`${p}search_graph\`, \`${p}search_and_read_symbols\`).
- If file-level code tools are present (exact body reads, file outlines, diagnostics, LSP or ast-grep matches, for example from pi-lens), use them for those. Those reads count toward read-before-edit; \`${graph}\` reads do not.
- Text and path search belongs to grep/find tools (ffgrep, fffind). \`${p}search_code\` is only for text matches grouped by symbol.
- If a project is not resolved, pass \`project\` as an absolute repo path; for current-project work, omit it.
- The current project is auto-indexed in the background and refreshed periodically. \`${graph}\` output is compact by default and hides analysis metadata, not location identity; retry with a higher max_symbol_lines or full_output=true if source is compacted.
`;
}
