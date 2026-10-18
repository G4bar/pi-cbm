import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CbmServices } from "../src/pi-tools/definitions.js";

const version = vi.hoisted(() => ({ warnings: [] as string[] }));

vi.mock("../src/cbm/version.js", () => ({
  consumeCbmVersionWarning: () => (version.warnings.length > 0 ? version.warnings.shift() : undefined),
}));

import { registerLifecycle } from "../src/extension/lifecycle.js";

type Handler = (event: unknown, context: unknown) => unknown;

function setup(activeTools: string[]) {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    getActiveTools: () => activeTools,
  } as unknown as ExtensionAPI;
  const indexCurrentRepo = vi.fn().mockResolvedValue({ status: "indexed", project: "repo", nodes: 3, edges: 4 });
  const services = {
    projects: { indexCurrentRepo },
    settings: { reload: vi.fn() },
  } as unknown as CbmServices;
  const status = vi.fn();
  const context = { cwd: "/repo", signal: new AbortController().signal, ui: { setStatus: status } };
  registerLifecycle(pi, services);
  return { handlers, status, context, indexCurrentRepo };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete process.env.PI_CBM_TOOLS;
  version.warnings.length = 0;
});

type PromptSectionsOptions = { systemPromptOptions: { sections: Record<string, string> } };

function promptSections(): PromptSectionsOptions {
  return { systemPromptOptions: { sections: {} } };
}

describe("lifecycle prompt gate", () => {
  it("sets the codebase_memory section instead of forcing the system prompt", () => {
    const { handlers, context } = setup(["cbm_search_graph"]);
    const event = promptSections();
    const result = handlers.get("before_agent_start")?.(event, context);

    expect(result).toBeUndefined();
    expect(Object.keys(event.systemPromptOptions.sections)).toEqual(["codebase_memory"]);
    expect(event.systemPromptOptions.sections.codebase_memory).toContain("Codebase-memory guidance");
  });

  it("uses a section name Pi accepts", () => {
    const { handlers, context } = setup(["cbm_search_graph"]);
    const event = promptSections();
    handlers.get("before_agent_start")?.(event, context);

    const name = Object.keys(event.systemPromptOptions.sections)[0] as string;
    expect(name).not.toBe("preamble");
    expect(name).toMatch(/^[a-z][a-z0-9_-]*$/);
  });

  it("leaves the prompt alone when no registered cbm tool is active", () => {
    const { handlers, context } = setup(["read"]);
    const event = promptSections();

    expect(handlers.get("before_agent_start")?.(event, context)).toBeUndefined();
    expect(event.systemPromptOptions.sections).toEqual({});
  });

  it("ignores a cbm tool that the allowlist did not register", () => {
    vi.stubEnv("PI_CBM_TOOLS", "search_graph");
    const { handlers, context } = setup(["cbm_trace_path"]);
    const event = promptSections();

    expect(handlers.get("before_agent_start")?.(event, context)).toBeUndefined();
    expect(event.systemPromptOptions.sections).toEqual({});
  });
});

describe("lifecycle status warnings", () => {
  it("keeps the version warning visible across refreshes", async () => {
    vi.useFakeTimers();
    version.warnings.push("newer than the tested range");
    const { handlers, status, context } = setup(["cbm_search_graph"]);

    handlers.get("session_start")?.({}, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenLastCalledWith("codebase-memory", expect.stringContaining("newer than the tested range"));
    expect(status).toHaveBeenLastCalledWith("codebase-memory", expect.stringContaining("3 nodes"));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(status).toHaveBeenLastCalledWith("codebase-memory", expect.stringContaining("newer than the tested range"));
  });

  it("surfaces unknown PI_CBM_TOOLS entries in the status", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_CBM_TOOLS", "trace_pth");
    const { handlers, status, context } = setup(["cbm_search_graph"]);

    handlers.get("session_start")?.({}, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenLastCalledWith("codebase-memory", expect.stringContaining("trace_pth"));
  });
});
