import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CBM_TOOL_BASE_NAMES, prefixedToolName, prefixToolReferences, resolveToolSelection } from "../shared/tool-prefix.js";
import { toolDefinitions, type CbmServices } from "./definitions.js";

/** Base names this extension registers, honoring `PI_CBM_TOOLS`. */
export function registeredToolBaseNames(): string[] {
  const { selected } = resolveToolSelection();
  return CBM_TOOL_BASE_NAMES.filter((name) => !selected || selected.has(name));
}

/** Registered names, honoring `PI_CBM_TOOLS` and the tool prefix. */
export function selectedToolNames(): string[] {
  return registeredToolBaseNames().map((name) => prefixedToolName(name));
}

/** `PI_CBM_TOOLS` entries that matched no base name. */
export function unknownAllowlistEntries(): string[] {
  return resolveToolSelection().unknown;
}

export function registerCodebaseMemoryTools(pi: ExtensionAPI, services: CbmServices) {
  const { selected, unknown } = resolveToolSelection();
  if (unknown.length > 0) {
    console.warn(`pi-cbm: PI_CBM_TOOLS ignored unknown tool name(s): ${unknown.join(", ")}`);
  }

  const baseNames = toolDefinitions.map((definition) => definition.name);
  const registered = new Set(baseNames.filter((name) => !selected || selected.has(name)));

  for (const definition of toolDefinitions) {
    if (!registered.has(definition.name)) continue;

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
