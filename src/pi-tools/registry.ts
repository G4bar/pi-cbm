import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { prefixedToolName, prefixToolReferences } from "../shared/tool-prefix.js";
import { toolDefinitions, type CbmServices } from "./definitions.js";

/** `PI_CBM_TOOLS` allowlist of base names; unset or empty registers every tool. */
function allowedBaseNames(): Set<string> | undefined {
  const configured = process.env.PI_CBM_TOOLS;
  if (configured === undefined) return undefined;
  const names = configured
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? new Set(names) : undefined;
}

/** Names this extension registers, honoring `PI_CBM_TOOLS` and the tool prefix. */
export function selectedToolNames(): string[] {
  const allowed = allowedBaseNames();
  return toolDefinitions
    .filter((definition) => !allowed || allowed.has(definition.name))
    .map((definition) => prefixedToolName(definition.name));
}

export function registerCodebaseMemoryTools(pi: ExtensionAPI, services: CbmServices) {
  const allowed = allowedBaseNames();
  const baseNames = toolDefinitions.map((definition) => definition.name);

  for (const definition of toolDefinitions) {
    if (allowed && !allowed.has(definition.name)) continue;

    pi.registerTool({
      name: prefixedToolName(definition.name),
      label: definition.label,
      description: prefixToolReferences(definition.description, baseNames),
      promptSnippet: prefixToolReferences(definition.promptSnippet, baseNames),
      promptGuidelines: definition.promptGuidelines.map((guideline) => prefixToolReferences(guideline, baseNames)),
      parameters: definition.parameters as any,
      async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
        return definition.execute(params, services, { cwd: ctx.cwd, signal: ctx.signal });
      },
      renderCall: definition.renderCall as any,
      renderResult: definition.renderResult as any,
    });
  }
}
