import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { codebaseMemoryPrompt } from "../src/extension/prompt.js";
import { toolDefinitions, type CbmServices } from "../src/pi-tools/definitions.js";
import { registerCodebaseMemoryTools } from "../src/pi-tools/registry.js";

const BASE_NAMES = toolDefinitions.map((definition) => definition.name);
const bareReference = (name: string) => new RegExp(`(?<!\\w)${name}(?!\\w)`);

function registeredGuidelines(): string[] {
  const guidelines: string[] = [];
  const pi = {
    registerTool: (tool: { promptGuidelines: string[] }) => guidelines.push(...tool.promptGuidelines),
  } as unknown as ExtensionAPI;
  registerCodebaseMemoryTools(pi, {} as CbmServices);
  return guidelines;
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
  });

  it("cross-references tools only by their prefixed names", () => {
    for (const name of BASE_NAMES) {
      expect(codebaseMemoryPrompt(), name).not.toMatch(bareReference(name));
      for (const guideline of registeredGuidelines()) {
        expect(guideline, name).not.toMatch(bareReference(name));
      }
    }
  });

  it("uses legacy names when the prefix is disabled", () => {
    process.env.PI_CBM_TOOL_PREFIX = "";
    const prompt = codebaseMemoryPrompt();

    expect(prompt).toContain("trace_path");
    expect(prompt).not.toContain("cbm_");
  });
});
