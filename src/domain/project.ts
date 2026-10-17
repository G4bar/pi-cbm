import { resolve } from "node:path";
import { CbmClient } from "../cbm/client.js";
import { indexTimeoutMs } from "../cbm/timeouts.js";
import { errorText } from "../shared/strings.js";
import { validateAutoIndexPath } from "./auto-index-paths.js";
import type { IndexCoordinator } from "./index-coordinator.js";

const AUTO_INDEX_MODE = "full";

/** Keep a missing `root_path` cached briefly so one failed lookup doesn't re-run per node in a batch. */
const ROOT_PATH_MISS_TTL_MS = 30_000;

export type CbmProject = {
  name: string;
  root_path?: string;
  nodes?: number;
  edges?: number;
  size_bytes?: number;
};

type ListProjectsData = {
  projects?: CbmProject[];
  error?: string;
  hint?: string;
};

export type ToolExecutionContext = {
  cwd: string;
  signal?: AbortSignal;
};

export type IndexResult =
  | {
      status: "indexed";
      project: string;
      nodes?: number;
      edges?: number;
      data: Record<string, unknown>;
    }
  | {
      status: "skipped";
      reason: string;
    };

export type AutoIndexSettings = {
  readonly autoIndexNonGitDirectories: boolean;
};

type AutoIndexTarget =
  | { ok: true; path: string; source: "git-root" | "cwd" }
  | { ok: false; reason: string };

/** POSIX-absolute or Windows drive-letter absolute, on any host platform. */
function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:[\\/]/i.test(value);
}

export class ProjectService {
  private readonly rootPaths = new Map<string, Promise<string | undefined>>();
  private readonly rootPathMisses = new Map<string, number>();

  constructor(
    private readonly cbm: CbmClient,
    private readonly settings: AutoIndexSettings,
    private readonly indexCoordinator: IndexCoordinator,
  ) {}

  async gitRoot(cwd: string, signal?: AbortSignal): Promise<string> {
    return this.cbm.gitRoot(cwd, signal);
  }

  projectNameFromPath(path: string): string {
    let normalized = resolve(path).replaceAll("\\", "/");
    normalized = normalized
      .split("")
      .map((char) => (/^[A-Za-z0-9._-]$/.test(char) ? char : "-"))
      .join("");

    normalized = normalized.replace(/-+/g, "-").replace(/\.+/g, ".").replace(/^[-.]+/, "").replace(/-+$/, "");
    return normalized || "root";
  }

  async listProjects(signal?: AbortSignal): Promise<CbmProject[]> {
    const result = await this.cbm.callTool("list_projects", {}, { signal, allowError: true });
    const data = result.data as ListProjectsData;
    if (!result.ok && data?.error?.includes("cannot read cache directory")) return [];
    if (!result.ok) throw new Error(errorText(result.data));
    return Array.isArray(data.projects) ? data.projects : [];
  }

  /**
   * cbm 0.12 `get_code_snippet` reports absolute `file_path`s while
   * `search_graph` reports repo-relative ones. Rewrite the path-ish keys against
   * the project's `root_path` so both agree; leave the value untouched when the
   * project or a matching root is unknown.
   */
  async relativizePaths(data: Record<string, unknown>, project: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!project) return data;
    const keys = ["file_path", "file", "path"].filter((key) => typeof data[key] === "string" && isAbsolutePath(data[key] as string));
    if (keys.length === 0) return data;

    const root = await this.projectRootPath(project, signal);
    if (!root) return data;

    const rootNormalized = root.replaceAll("\\", "/").replace(/\/+$/, "");
    const caseInsensitive = /^[a-z]:/i.test(rootNormalized);
    const comparableRoot = caseInsensitive ? rootNormalized.toLowerCase() : rootNormalized;
    const result = { ...data };
    for (const key of keys) {
      const value = data[key] as string;
      const normalizedValue = value.replaceAll("\\", "/");
      const comparableValue = caseInsensitive ? normalizedValue.toLowerCase() : normalizedValue;
      if (comparableValue.startsWith(`${comparableRoot}/`)) result[key] = normalizedValue.slice(rootNormalized.length + 1);
    }
    return result;
  }

  private projectRootPath(project: string, signal?: AbortSignal): Promise<string | undefined> {
    const cached = this.rootPaths.get(project);
    if (cached) return cached;
    const missAt = this.rootPathMisses.get(project);
    if (missAt !== undefined && Date.now() - missAt < ROOT_PATH_MISS_TTL_MS) return Promise.resolve(undefined);

    const request = this.listProjects(signal)
      .then((projects) => projects.find((entry) => entry.name === project)?.root_path)
      .catch(() => undefined);
    this.rootPaths.set(project, request);
    void request.then((root) => {
      if (root) return;
      this.rootPaths.delete(project);
      this.rootPathMisses.set(project, Date.now());
    });
    return request;
  }

  async inferProject(cwd: string, signal?: AbortSignal): Promise<string> {
    const root = await this.gitRoot(cwd, signal);
    const projects = await this.listProjects(signal);
    const cwdResolved = resolve(cwd);
    const rootResolved = resolve(root);

    const matching = projects
      .filter((project) => project.root_path)
      .map((project) => ({ project, rootPath: resolve(project.root_path!) }))
      .filter(({ rootPath }) => cwdResolved === rootPath || cwdResolved.startsWith(`${rootPath}/`) || rootResolved === rootPath)
      .sort((a, b) => b.rootPath.length - a.rootPath.length);

    return matching[0]?.project.name ?? this.projectNameFromPath(root);
  }

  async defaultRepoPath(cwd: string, signal?: AbortSignal): Promise<string> {
    return this.gitRoot(cwd, signal);
  }

  async autoIndexTarget(cwd: string, signal?: AbortSignal): Promise<AutoIndexTarget> {
    const gitRoot = await this.cbm.findGitRoot(cwd, signal);
    if (gitRoot) {
      const validation = validateAutoIndexPath(gitRoot);
      if (!validation.ok) return validation;
      return { ok: true, path: validation.path, source: "git-root" };
    }

    if (!this.settings.autoIndexNonGitDirectories) {
      return { ok: false, reason: "not inside a git repository and non-git auto-indexing is disabled" };
    }

    const validation = validateAutoIndexPath(cwd);
    if (!validation.ok) return validation;
    return { ok: true, path: validation.path, source: "cwd" };
  }

  async indexCurrentRepo(cwd: string, signal?: AbortSignal): Promise<IndexResult> {
    const target = await this.autoIndexTarget(cwd, signal);
    if (!target.ok) {
      return { status: "skipped", reason: target.reason };
    }

    const coordination = await this.indexCoordinator.acquire(target.path, signal);
    if (!coordination.ok) {
      return { status: "skipped", reason: coordination.reason };
    }

    try {
      const result = await this.cbm.callTool(
        "index_repository",
        { repo_path: target.path, mode: AUTO_INDEX_MODE },
        { signal: coordination.lease.signal, timeoutMs: indexTimeoutMs(undefined) },
      );
      const data = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {};
      return {
        status: "indexed",
        project: typeof data.project === "string" ? data.project : "ready",
        nodes: typeof data.nodes === "number" ? data.nodes : undefined,
        edges: typeof data.edges === "number" ? data.edges : undefined,
        data,
      };
    } finally {
      await coordination.lease.release();
    }
  }
}
