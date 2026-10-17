import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { CbmServices } from "../src/pi-tools/definitions.js";
import { registerCodebaseMemoryTools } from "../src/pi-tools/registry.js";

function registeredTools(): Array<{ name: string; promptGuidelines: string[] }> {
  const tools: Array<{ name: string; promptGuidelines: string[] }> = [];
  const pi = {
    registerTool: (tool: { name: string; promptGuidelines: string[] }) => tools.push(tool),
  } as unknown as ExtensionAPI;
  registerCodebaseMemoryTools(pi, {} as CbmServices);
  return tools;
}

afterEach(() => {
  delete process.env.PI_CBM_TOOL_PREFIX;
  delete process.env.PI_CBM_TOOLS;
});

describe("pi-cbm tool registry", () => {
  it("prefixes every tool with cbm_ by default", () => {
    const names = registeredTools().map((tool) => tool.name);

    expect(names).toHaveLength(13);
    expect(names.every((name) => name.startsWith("cbm_"))).toBe(true);
    for (const collision of ["read_symbol", "symbol_search", "module_report", "read_enclosing", "project_report"]) {
      expect(names).not.toContain(collision);
    }
  });

  it("registers the legacy names when PI_CBM_TOOL_PREFIX is empty", () => {
    process.env.PI_CBM_TOOL_PREFIX = "";
    const names = registeredTools().map((tool) => tool.name);

    expect(names).toHaveLength(13);
    expect(names).toContain("search_graph");
    expect(names).toContain("read_symbol");
  });

  it("registers only the PI_CBM_TOOLS allowlist when set", () => {
    process.env.PI_CBM_TOOLS = "search_graph,trace_path";
    expect(registeredTools().map((tool) => tool.name)).toEqual(["cbm_search_graph", "cbm_trace_path"]);
  });

  it("treats an empty PI_CBM_TOOLS as unset", () => {
    process.env.PI_CBM_TOOLS = "";
    expect(registeredTools()).toHaveLength(13);
  });
});
