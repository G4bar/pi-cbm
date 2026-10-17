import { describe, expect, it } from "vitest";
import type { CbmClient } from "../src/cbm/client.js";
import type { CbmCallResult } from "../src/cbm/result.js";
import type { IndexCoordinator } from "../src/domain/index-coordinator.js";
import { OutputService } from "../src/domain/output.js";
import { ProjectService, type ToolExecutionContext } from "../src/domain/project.js";
import { QueryService } from "../src/domain/query.js";
import type { TraceService } from "../src/domain/trace.js";

const CTX: ToolExecutionContext = { cwd: "/tmp/cbm-fixture-repo" };

function queryServiceWith(callTool: (tool: string, args: Record<string, unknown>) => CbmCallResult | Promise<CbmCallResult>): QueryService {
  const cbm = {
    callTool: async (tool: string, args: Record<string, unknown>): Promise<CbmCallResult> => {
      if (tool === "list_projects") {
        return { ok: true, data: { projects: [{ name: "repo", root_path: "/tmp/cbm-fixture-repo" }], has_more: false }, rawText: "", stderr: "" };
      }
      return callTool(tool, args);
    },
    findGitRoot: async () => undefined,
  } as unknown as CbmClient;
  const projects = new ProjectService(cbm, { autoIndexNonGitDirectories: false }, {} as IndexCoordinator);
  return new QueryService(cbm, projects, new OutputService(), {} as TraceService);
}

const projectError = () => {
  throw new Error('{"error":"project not found or not indexed","available_projects":["tmp-cbm-fixture-repo"]}');
};

describe("QueryService project errors", () => {
  it("rethrows a query_graph project error with the actionable project list", async () => {
    const service = queryServiceWith(projectError);

    await expect(service.queryGraph({ project: "repo" }, CTX)).rejects.toThrow(
      /project not found or not indexed.*indexed projects: repo -> \/tmp\/cbm-fixture-repo.*absolute path/,
    );
  });

  it("rethrows a query-tool project error with the actionable project list", async () => {
    const service = queryServiceWith(projectError);

    await expect(service.executeQueryTool("Snippet", "get_code_snippet", { qualified_name: "x", project: "repo" }, CTX)).rejects.toThrow(
      /project not found or not indexed.*absolute path/,
    );
  });
});

describe("query_graph 0.12 shapes", () => {
  it("coerces numeric metrics and keeps the paging meta", async () => {
    const service = queryServiceWith(async () => ({
      ok: true,
      data: { columns: ["name", "complexity"], rows: [["a", "5"]], returned: 1, total: 1, has_more: false },
      rawText: "",
      stderr: "",
    }));

    const result = await service.queryGraph({ query: "MATCH (n) RETURN n.name, n.complexity" }, CTX);
    const data = result.details.data as Record<string, unknown>;
    expect(data.rows).toEqual([["a", 5]]);
    expect(data.returned).toBe(1);
    expect(data.has_more).toBe(false);
  });
});
