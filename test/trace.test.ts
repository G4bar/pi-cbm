import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CbmCallResult } from "../src/cbm/result.js";
import type { CbmClient } from "../src/cbm/client.js";
import { normalizeCbmData } from "../src/cbm/normalize.js";
import { OutputService } from "../src/domain/output.js";
import { ProjectService, type ToolExecutionContext } from "../src/domain/project.js";
import type { IndexCoordinator } from "../src/domain/index-coordinator.js";
import { SymbolService } from "../src/domain/symbols.js";
import { TraceService } from "../src/domain/trace.js";

const FIXTURE_DIR = new URL("./fixtures/cbm-0.12.1/", import.meta.url);
const PROJECT = "tmp-cbm-fixture-repo";
const ROOT = "/tmp/cbm-fixture-repo";
const CTX: ToolExecutionContext = { cwd: ROOT };

function fixture(name: string): CbmCallResult {
  const envelope = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8")) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const text = envelope.content[0]?.text ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { ok: envelope.isError !== true, data: normalizeCbmData(parsed), rawText: text, stderr: "" };
}

/** The real tool echoes the requested qn; the mock does the same so enrichment stays truthful. */
function snippetFor(args: Record<string, unknown>): CbmCallResult {
  const result = fixture("get_code_snippet.known");
  return { ...result, data: { ...(result.data as Record<string, unknown>), qualified_name: args.qualified_name } };
}

function fakeClient(handler: (tool: string, args: Record<string, unknown>) => CbmCallResult): CbmClient {
  return {
    callTool: async (tool: string, args: Record<string, unknown>) =>
      tool === "list_projects" ? fixture("list_projects.format-flag") : handler(tool, args),
  } as unknown as CbmClient;
}

function traceService(handler: (tool: string, args: Record<string, unknown>) => CbmCallResult): TraceService {
  const cbm = fakeClient(handler);
  const projects = new ProjectService(cbm, { autoIndexNonGitDirectories: false }, {} as IndexCoordinator);
  const output = new OutputService();
  return new TraceService(cbm, projects, output, new SymbolService(cbm, projects, output));
}

function handlerWithTrace(traceResult: (args: Record<string, unknown>) => CbmCallResult) {
  return (tool: string, args: Record<string, unknown>): CbmCallResult => {
    if (tool === "trace_path") return traceResult(args);
    if (tool === "get_code_snippet") return snippetFor(args);
    if (tool === "search_graph") return fixture("search_graph.name-pattern");
    throw new Error(`unexpected cbm tool: ${tool}`);
  };
}

describe("TraceService on cbm 0.12 shapes", () => {
  it("feeds the normalized caller/callee arrays through and enriches their locations", async () => {
    const service = traceService(handlerWithTrace(() => fixture("trace_path.depth1")));
    const result = await service.trace({ function_name: "callTool", project: PROJECT }, CTX);
    const data = result.details.data as Record<string, unknown>;

    const callers = data.callers as Array<Record<string, unknown>>;
    expect(callers.some((item) => item.qualified_name === "tmp-cbm-fixture-repo.src.domain.symbols.SymbolService.fetchSymbolLocation")).toBe(true);
    expect(callers.every((item) => item.file_path === "src/cbm/client.ts")).toBe(true);

    const callees = data.callees as Array<Record<string, unknown>>;
    expect(callees.some((item) => item.qualified_name === "tmp-cbm-fixture-repo.src.cbm.envelope.parseMaybeJson")).toBe(true);
    expect(data.callers_total).toBe(11);
    expect(data.callees_total).toBe(6);
  });

  it("retries a function-not-found trace with the qualified name found by search_graph", async () => {
    const service = traceService(
      handlerWithTrace((args) => (args.function_name === "noSuchFunction" ? fixture("trace_path.unknown") : fixture("trace_path.depth1"))),
    );
    const result = await service.trace({ function_name: "noSuchFunction", project: PROJECT }, CTX);

    expect(result.details.resolved_from).toBe("noSuchFunction");
    expect((result.details.args as Record<string, unknown>).function_name).toBe("tmp-cbm-fixture-repo.src.cbm.client.CbmClient.callTool");
    expect((result.details.data as Record<string, unknown>).callers_total).toBe(11);
  });

  it("applies exclude_paths after locations are enriched", async () => {
    const service = traceService(handlerWithTrace(() => fixture("trace_path.depth1")));
    const result = await service.trace({ function_name: "callTool", project: PROJECT, exclude_paths: ["src/cbm/"] }, CTX);
    const data = result.details.data as Record<string, unknown>;

    expect(data.callers).toEqual([]);
    expect(data.callees).toEqual([]);
  });
});
