import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CbmCallResult } from "../src/cbm/result.js";
import type { CbmClient } from "../src/cbm/client.js";
import { normalizeCbmData } from "../src/cbm/normalize.js";
import { OutputService } from "../src/domain/output.js";
import { ProjectService, type ToolExecutionContext } from "../src/domain/project.js";
import type { IndexCoordinator } from "../src/domain/index-coordinator.js";
import { SymbolService } from "../src/domain/symbols.js";

const FIXTURE_DIR = new URL("./fixtures/cbm-0.12.1/", import.meta.url);
const PROJECT = "tmp-cbm-fixture-repo";
const ROOT = "/tmp/cbm-fixture-repo";
const CTX: ToolExecutionContext = { cwd: ROOT };

/** Raw 0.12.1 fixture through the same parse + normalize path as CbmClient. */
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

function fakeClient(handler: (tool: string, args: Record<string, unknown>) => CbmCallResult): CbmClient {
  return {
    callTool: async (tool: string, args: Record<string, unknown>) =>
      tool === "list_projects" ? fixture("list_projects.format-flag") : handler(tool, args),
  } as unknown as CbmClient;
}

function serviceWith(handler: (tool: string, args: Record<string, unknown>) => CbmCallResult): SymbolService {
  const cbm = fakeClient(handler);
  const projects = new ProjectService(cbm, { autoIndexNonGitDirectories: false }, {} as IndexCoordinator);
  return new SymbolService(cbm, projects, new OutputService());
}

const searchByName = () => fixture("search_graph.name-pattern");

describe("SymbolService on cbm 0.12 shapes", () => {
  it("resolves a one-hit name to one candidate with a repo-relative location", async () => {
    const service = serviceWith(() => searchByName());
    const resolution = await service.resolveCandidates({ name: "callTool", project: PROJECT }, CTX);

    expect(resolution.candidates).toHaveLength(1);
    expect(resolution.candidates[0]).toMatchObject({
      name: "callTool",
      qualified_name: "tmp-cbm-fixture-repo.src.cbm.client.CbmClient.callTool",
      file_path: "src/cbm/client.ts",
      start_line: 43,
      end_line: 100,
    });
  });

  it("keeps every row as a candidate when the name matches none exactly", async () => {
    const service = serviceWith(() => fixture("search_graph.label"));
    const resolution = await service.resolveCandidates({ name: "missing", project: PROJECT }, CTX);

    expect(resolution.candidates.map((candidate) => candidate.name)).toEqual([
      "abortAll",
      "acquire",
      "autoIndexNonGitDirectories",
    ]);
  });

  it("throws a contract error instead of returning [] for an unrecognized search_graph shape", async () => {
    const service = serviceWith(() => ({
      ok: true,
      data: { qn_rule: 'qn = qn_prefix + "." + name', cols: ["name", "label"] },
      rawText: "",
      stderr: "",
    }));

    await expect(service.resolveCandidates({ name: "callTool", project: PROJECT }, CTX)).rejects.toThrow(
      /codebase-memory-mcp search_graph.*unrecognized result shape.*qn_rule, cols/,
    );
  });

  it("treats empty results as a legitimate symbol-not-found", async () => {
    const service = serviceWith(() => ({ ok: true, data: { total: 0, has_more: false, results: [] }, rawText: "", stderr: "" }));
    const result = await service.resolve({ name: "missing", project: PROJECT }, CTX);

    expect(result.details.data).toMatchObject({ error: "symbol not found", total_candidates: 0 });
  });

  it("rewrites an absolute get_code_snippet file_path to repo-relative", async () => {
    const service = serviceWith((tool) => (tool === "get_code_snippet" ? fixture("get_code_snippet.known") : searchByName()));

    const location = await service.fetchSymbolLocation("tmp-cbm-fixture-repo.src.cbm.client.CbmClient.callTool", PROJECT, CTX, {}, new Map());
    expect(location.file_path).toBe("src/cbm/client.ts");

    const read = await service.read({ name: "callTool", project: PROJECT }, CTX);
    const data = read.details.data as Record<string, unknown>;
    expect(data.file_path).toBe("src/cbm/client.ts");
    expect(JSON.stringify(data)).not.toContain(ROOT);
  });
});
