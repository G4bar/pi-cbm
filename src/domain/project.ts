import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { CbmClient } from "../cbm/client.js";
import { indexTimeoutMs } from "../cbm/timeouts.js";
import { errorText, errorTextWithDetails } from "../shared/strings.js";
import { validateAutoIndexPath } from "./auto-index-paths.js";
import type { IndexCoordinator } from "./index-coordinator.js";

const AUTO_INDEX_MODE = "full";

/** Keep a missing `root_path` cached briefly so one failed lookup doesn't re-run per node in a batch. */
const ROOT_PATH_MISS_TTL_MS = 30_000;

/** Shared by validation and path rewriting so a burst of tool calls spawns `list_projects` once. */
const PROJECTS_CACHE_TTL_MS = 10_000;

const MAX_LISTED_PROJECTS = 10;

/** cbm rejects projects by index, not by name/path spelling. */
const PROJECT_ERROR_PATTERN = /project not found|not indexed/i;

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
  private projectsCache?: { at: number; value: CbmProject[] };
  private projectsInFlight?: Promise<CbmProject[]>;

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
    const cached = this.projectsCache;
    if (cached && Date.now() - cached.at < PROJECTS_CACHE_TTL_MS) return cached.value;
    this.projectsInFlight ??= this.fetchProjects(signal)
      .then((projects) => {
        this.projectsCache = { at: Date.now(), value: projects };
        return projects;
      })
      .finally(() => {
        this.projectsInFlight = undefined;
      });
    return this.projectsInFlight;
  }

  private async fetchProjects(signal?: AbortSignal): Promise<CbmProject[]> {
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

  /**
   * Resolve the `project` a tool should use. Explicit names and absolute paths
   * are validated against the indexed projects; an unmatched value throws with
   * the indexed list instead of letting cbm answer "symbol not found".
   */
  async resolveProject(explicit: unknown, cwd: string, signal?: AbortSignal): Promise<string> {
    const given = typeof explicit === "string" ? explicit.trim() : "";
    const projects = await this.listProjects(signal);

    if (given) {
      if (projects.some((project) => project.name === given)) return given;
      if (isAbsolutePath(given)) {
        const match = await this.matchProject(projects, [given]);
        if (match) return match.name;
      }
      throw new Error(this.projectResolutionMessage(given, cwd, await this.gitRootOrUndefined(cwd, signal), projects));
    }

    const gitRoot = await this.gitRootOrUndefined(cwd, signal);
    const match = await this.matchProject(projects, gitRoot ? [cwd, gitRoot] : [cwd]);
    if (match) return match.name;
    throw new Error(this.projectResolutionMessage(undefined, cwd, gitRoot, projects));
  }

  /**
   * cbm can still reject a project `resolveProject` accepted (e.g. its index was
   * dropped). Keep cbm's detail but append the same actionable project list.
   */
  async projectLookupError(value: unknown, project: string, cwd: string, signal?: AbortSignal): Promise<Error> {
    const text = errorTextWithDetails(value);
    if (!PROJECT_ERROR_PATTERN.test(text)) return new Error(text);
    const projects = await this.listProjects(signal).catch(() => []);
    const gitRoot = await this.gitRootOrUndefined(cwd, signal);
    return new Error(`${text} ${this.projectResolutionMessage(project || undefined, cwd, gitRoot, projects)}`);
  }

  private async gitRootOrUndefined(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.cbm.findGitRoot(cwd, signal);
    } catch {
      return undefined;
    }
  }

  private async matchProject(projects: CbmProject[], paths: string[]): Promise<CbmProject | undefined> {
    const plain = this.longestPrefix(await this.projectRoots(projects, false), paths.map((path) => resolve(path)));
    if (plain) return plain;
    // Symlinked cwd/root: retry with both sides canonicalized.
    const canonicalPaths = await Promise.all(paths.map((path) => realpath(path).catch(() => resolve(path))));
    return this.longestPrefix(await this.projectRoots(projects, true), canonicalPaths);
  }

  private async projectRoots(projects: CbmProject[], canonicalize: boolean): Promise<Array<{ project: CbmProject; root: string }>> {
    const roots: Array<{ project: CbmProject; root: string }> = [];
    for (const project of projects) {
      if (!project.root_path) continue;
      const resolvedPath = resolve(project.root_path);
      const root = canonicalize ? await realpath(project.root_path).catch(() => resolvedPath) : resolvedPath;
      roots.push({ project, root: root.replaceAll("\\", "/") });
    }
    return roots;
  }

  private longestPrefix(roots: Array<{ project: CbmProject; root: string }>, paths: string[]): CbmProject | undefined {
    const normalized = paths.map((path) => path.replaceAll("\\", "/"));
    return roots
      .filter(({ root }) => normalized.some((path) => path === root || path.startsWith(`${root}/`)))
      .sort((a, b) => b.root.length - a.root.length)[0]?.project;
  }

  private projectResolutionMessage(given: string | undefined, cwd: string, gitRoot: string | undefined, projects: CbmProject[]): string {
    const listed = projects.slice(0, MAX_LISTED_PROJECTS).map((project) => `${project.name} -> ${project.root_path ?? "(unknown root)"}`);
    const more = projects.length > listed.length ? ` (+${projects.length - listed.length} more)` : "";
    const available = listed.length > 0 ? `indexed projects: ${listed.join(", ")}${more}` : "no projects are indexed yet";
    let tried = `cwd "${cwd}", which has no git root`;
    if (given) tried = `the given value "${given}" (as a project name and as an absolute path)`;
    else if (gitRoot) tried = `cwd "${cwd}" and its git root "${gitRoot}"`;
    return [
      `No indexed project matches ${tried}.`,
      available,
      "pass `project` as one of these names or as the repo's absolute path (required when the cwd is outside the repo)",
      "if the repository was just indexed, indexing may still be running",
    ].join("; ");
  }

  private invalidateProjectCaches(): void {
    this.projectsCache = undefined;
    this.rootPaths.clear();
    this.rootPathMisses.clear();
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
      this.invalidateProjectCaches();
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
