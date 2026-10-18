import { isBaseToolRegistered, toolPrefix } from "../shared/tool-prefix.js";

/**
 * Division of labor between the code graph (`cbm_*`) and file-level code tools.
 * Built with the configured prefix and only mentions registered tools, so an
 * empty `PI_CBM_TOOL_PREFIX` or a `PI_CBM_TOOLS` allowlist reads correctly.
 */
export function codebaseMemoryPrompt(): string {
  const p = toolPrefix();
  const graph = `${p}*`;

  const graphParts: string[] = [];
  if (isBaseToolRegistered("trace_path")) graphParts.push(`callers/callees (\`${p}trace_path\`)`);
  if (isBaseToolRegistered("detect_changes")) graphParts.push(`blast radius (\`${p}detect_changes\`)`);
  if (isBaseToolRegistered("get_architecture")) graphParts.push(`architecture (\`${p}get_architecture\`)`);
  const finders = ["search_graph", "search_and_read_symbols"]
    .filter((base) => isBaseToolRegistered(base))
    .map((base) => `\`${p}${base}\``);
  if (finders.length > 0) graphParts.push(`finding implementations by meaning (${finders.join(", ")})`);

  const graphLine =
    graphParts.length > 0
      ? `- \`${graph}\` tools read the code graph: cross-file structure, ${graphParts.join(", ")}.`
      : `- \`${graph}\` tools read the code graph: cross-file structure.`;
  const searchLine = isBaseToolRegistered("search_code")
    ? `- Text and path search belongs to grep/find tools. \`${p}search_code\` is only for text matches grouped by symbol.`
    : "- Text and path search belongs to grep/find tools.";

  return `

Codebase-memory guidance:
${graphLine}
- If file-level code tools are present (exact body reads, file outlines, diagnostics, LSP or ast-grep matches, for example from pi-lens), use them for those. Those reads count toward read-before-edit; \`${graph}\` reads do not.
${searchLine}
- If a project is not resolved, pass \`project\` as an absolute repo path; for current-project work, omit it.
- The current project is auto-indexed in the background and refreshed periodically. \`${graph}\` output is compact by default and hides analysis metadata, not location identity; retry with a higher max_symbol_lines or full_output=true if source is compacted.
`;
}
