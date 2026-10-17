import { describe, expect, it } from "vitest";
import type { CbmClient } from "../src/cbm/client.js";
import type { CbmCallResult } from "../src/cbm/result.js";
import type { IndexCoordinator } from "../src/domain/index-coordinator.js";
import { ProjectService } from "../src/domain/project.js";

type FakeOptions = {
  projects?: Array<{ name: string; root_path: string }>;
  gitRoot?: string;
  onListProjects?: () => void;
};

function serviceWith(options: FakeOptions = {}): ProjectService {
  const projects = options.projects ?? [{ name: "repo", root_path: "/work/repo" }];
  const cbm = {
    callTool: async (tool: string): Promise<CbmCallResult> => {
      if (tool !== "list_projects") throw new Error(`unexpected cbm tool: ${tool}`);
      options.onListProjects?.();
      return { ok: true, data: { projects, total: projects.length, has_more: false }, rawText: "", stderr: "" };
    },
    findGitRoot: async () => options.gitRoot,
  } as unknown as CbmClient;
  return new ProjectService(cbm, { autoIndexNonGitDirectories: false }, {} as IndexCoordinator);
}

describe("ProjectService.resolveProject", () => {
  it("infers the project whose root contains the cwd", async () => {
    await expect(serviceWith().resolveProject(undefined, "/work/repo/src/domain")).resolves.toBe("repo");
  });

  it("picks the longest matching root for nested projects", async () => {
    const service = serviceWith({
      projects: [
        { name: "outer", root_path: "/work" },
        { name: "inner", root_path: "/work/repo" },
      ],
    });

    await expect(service.resolveProject(undefined, "/work/repo/src")).resolves.toBe("inner");
  });

  it("fails loudly with the indexed projects when the cwd matches nothing", async () => {
    const service = serviceWith({ projects: [{ name: "other", root_path: "/work/other" }] });

    await expect(service.resolveProject(undefined, "/home/gabar")).rejects.toThrow(/cwd "\/home\/gabar", which has no git root/);
    await expect(service.resolveProject(undefined, "/home/gabar")).rejects.toThrow(/indexed projects: other -> \/work\/other/);
    await expect(service.resolveProject(undefined, "/home/gabar")).rejects.toThrow(/absolute path/);
  });

  it("maps an explicit absolute path to the indexed project name", async () => {
    await expect(serviceWith().resolveProject("/work/repo/src", "/home/gabar")).resolves.toBe("repo");
  });

  it("rejects an unknown project name with the actionable list, not symbol-not-found", async () => {
    let message = "";
    try {
      await serviceWith().resolveProject("home-gabar", "/home/gabar");
      expect.unreachable("unknown project should throw");
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/given value "home-gabar"/);
    expect(message).toMatch(/indexed projects: repo -> \/work\/repo/);
    expect(message).toMatch(/absolute path/);
    expect(message).not.toMatch(/symbol not found/i);
  });

  it("caches list_projects across resolutions within the TTL", async () => {
    let listCalls = 0;
    const service = serviceWith({ onListProjects: () => (listCalls += 1) });

    await service.resolveProject(undefined, "/work/repo");
    await service.resolveProject("/work/repo/src", "/home/gabar");

    expect(listCalls).toBe(1);
  });
});
