import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CbmClient } from "../src/cbm/client.js";
import type { CbmCallResult } from "../src/cbm/result.js";
import { INDEX_LEASE_HELD_REASON, type IndexCoordinator, type IndexLeaseResult } from "../src/domain/index-coordinator.js";
import { OutputService } from "../src/domain/output.js";
import { ProjectService, type ToolExecutionContext } from "../src/domain/project.js";
import { QueryService } from "../src/domain/query.js";
import type { TraceService } from "../src/domain/trace.js";

const traceStub = { enrichTraceLocations: async (data: unknown) => data } as unknown as TraceService;

type Harness = {
  ctx: ToolExecutionContext;
  calls: string[];
  query: QueryService;
  cleanup(): Promise<void>;
};

async function harness(acquire: (path: string) => Promise<IndexLeaseResult>): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "pi-cbm-freshness-"));
  const root = join(base, "repo");
  await mkdir(root);

  const calls: string[] = [];
  const cbm = {
    callTool: async (tool: string): Promise<CbmCallResult> => {
      calls.push(tool);
      if (tool === "list_projects") {
        return { ok: true, data: { projects: [{ name: "repo", root_path: root }], has_more: false }, rawText: "", stderr: "" };
      }
      if (tool === "index_repository") {
        return { ok: true, data: { project: "repo", nodes: 1, edges: 1 }, rawText: "", stderr: "" };
      }
      if (tool === "detect_changes") {
        return { ok: true, data: { base: "main", changed_files: [], impacted: [] }, rawText: "", stderr: "" };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
    findGitRoot: async () => root,
  } as unknown as CbmClient;
  const projects = new ProjectService(cbm, { autoIndexNonGitDirectories: false }, { acquire } as unknown as IndexCoordinator);

  return {
    ctx: { cwd: root },
    calls,
    query: new QueryService(cbm, projects, new OutputService(), traceStub),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

function okLease(): IndexLeaseResult {
  return { ok: true, lease: { signal: new AbortController().signal, release: async () => undefined } };
}

function detectChanges(h: Harness) {
  return h.query.executeQueryTool("Change impact results", "detect_changes", {}, h.ctx);
}

const indexCount = (h: Harness) => h.calls.filter((tool) => tool === "index_repository").length;
const freshness = (result: Awaited<ReturnType<typeof detectChanges>>) =>
  String((result.details.data as Record<string, unknown>).index_freshness);

describe("detect_changes index freshness", () => {
  it("indexes once, then skips a second call inside the freshness window", async () => {
    const h = await harness(async () => okLease());
    try {
      expect(freshness(await detectChanges(h))).toContain("index refreshed");
      expect(indexCount(h)).toBe(1);

      expect(freshness(await detectChanges(h))).toContain("index refreshed");
      expect(indexCount(h)).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it("waits for a lease held by another session instead of skipping", async () => {
    let attempts = 0;
    const h = await harness(async () => {
      attempts += 1;
      return attempts === 1 ? { ok: false, reason: INDEX_LEASE_HELD_REASON } : okLease();
    });
    try {
      await detectChanges(h);
      expect(attempts).toBe(2);
      expect(indexCount(h)).toBe(1);
    } finally {
      await h.cleanup();
    }
  });
});
