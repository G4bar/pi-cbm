import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { codebaseMemoryPrompt } from "../src/extension/prompt.js";
import { toolDefinitions, type CbmServices } from "../src/pi-tools/definitions.js";
import { registerCodebaseMemoryTools } from "../src/pi-tools/registry.js";

const BASE_NAMES = toolDefinitions.map((definition) => definition.name);
const bareReference = (name: string) => new RegExp(`(?<!\\w)${name}(?!\\w)`);

type RegisteredTool = { name: string; description: string; promptSnippet: string; promptGuidelines: string[] };

function registeredTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  } as unknown as ExtensionAPI;
  registerCodebaseMemoryTools(pi, {} as CbmServices);
  return tools;
}

afterEach(() => {
  delete process.env.PI_CBM_TOOL_PREFIX;
  delete process.env.PI_CBM_TOOLS;
});

describe("codebase-memory system prompt", () => {
  it("splits graph work from file-level code tools", () => {
    const prompt = codebaseMemoryPrompt();

    expect(prompt.toLowerCase()).not.toContain("strongly prefer");
    expect(prompt).toContain("cbm_trace_path");
    expect(prompt).toContain("cbm_detect_changes");
    expect(prompt).toContain("cbm_get_architecture");
    expect(prompt).toContain("read-before-edit");
    expect(prompt).toContain("absolute repo path");
    expect(prompt).not.toContain("ffgrep");
  });

  it("cross-references tools only by their prefixed names", () => {
    const prompt = codebaseMemoryPrompt();
    const tools = registeredTools();

    for (const name of BASE_NAMES) {
      expect(prompt, name).not.toMatch(bareReference(name));
      for (const tool of tools) {
        expect(tool.description, `${tool.name} description`).not.toMatch(bareReference(name));
        expect(tool.promptSnippet, `${tool.name} snippet`).not.toMatch(bareReference(name));
        for (const guideline of tool.promptGuidelines) {
          expect(guideline, `${tool.name} guideline`).not.toMatch(bareReference(name));
        }
      }
    }
  });

  it("keeps per-tool guidelines consistent with the division of labor", () => {
    const guidelines = registeredTools().flatMap((tool) => tool.promptGuidelines);

    for (const guideline of guidelines) {
      expect(guideline).not.toMatch(/prefer .*over raw file reads/i);
      expect(guideline).not.toMatch(/falling back to read\/grep/i);
      expect(guideline).not.toMatch(/search_code[^.]*exact literal/i);
    }
  });

  it("mentions only registered tools when PI_CBM_TOOLS is set", () => {
    process.env.PI_CBM_TOOLS = "search_graph";
    const prompt = codebaseMemoryPrompt();

    expect(prompt).toContain("cbm_search_graph");
    for (const absent of ["cbm_trace_path", "cbm_detect_changes", "cbm_get_architecture", "cbm_search_and_read_symbols", "cbm_search_code"]) {
      expect(prompt).not.toContain(absent);
    }
  });

  it("uses legacy names when the prefix is disabled", () => {
    process.env.PI_CBM_TOOL_PREFIX = "";
    const prompt = codebaseMemoryPrompt();

    expect(prompt).toContain("trace_path");
    expect(prompt).not.toContain("cbm_");
  });
});
