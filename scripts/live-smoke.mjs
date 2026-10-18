// Opt-in end-to-end check: drives the extension's own services against a real
// codebase-memory-mcp binary. Never runs from vitest.
//
//   CBM_BIN=/path/to/codebase-memory-mcp [CBM_BIN_OLD=/path/to/0.9.x] npm run smoke:live
//
// Both the cbm cache and the indexed repo are temp copies, so the user's real
// cache and ~/.cache are untouched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The sources import each other with `.js` specifiers; map those to `.ts` so
// Node's type stripping can load them (registerHooks needs Node >= 22.15).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.endsWith(".js")) throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});

const { CbmClient } = await import("../src/cbm/client.ts");
const { IndexCoordinator } = await import("../src/domain/index-coordinator.ts");
const { OutputService } = await import("../src/domain/output.ts");
const { ProjectService } = await import("../src/domain/project.ts");
const { QueryService } = await import("../src/domain/query.ts");
const { SymbolService } = await import("../src/domain/symbols.ts");
const { TraceService } = await import("../src/domain/trace.ts");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYMBOL = "callTool";
const EDITED_FILE = "src/shared/strings.ts";

// CODEBASE_MEMORY_MCP_BIN outranks CBM_BIN in resolveCbmBinary, so keep them in sync.
function useBinary(path) {
  process.env.CBM_BIN = path;
  process.env.CODEBASE_MEMORY_MCP_BIN = path;
}

run().catch((error) => {
  console.error(`live smoke crashed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});

async function run() {
  const binary = process.env.CBM_BIN?.trim() || process.env.CODEBASE_MEMORY_MCP_BIN?.trim();
  if (!binary) {
    console.log("live smoke: SKIP (set CBM_BIN=/path/to/codebase-memory-mcp)");
    return;
  }
  const oldBinary = process.env.CBM_BIN_OLD?.trim();

  const workdir = await mkdtemp(join(tmpdir(), "pi-cbm-smoke-"));
  const cacheDir = join(workdir, "cache");
  const repoDir = join(workdir, "repo");
  const outsideDir = join(workdir, "outside");
  const passed = [];
  const skipped = [];
  const failed = [];

  const step = async (name, runStep) => {
    try {
      const evidence = await runStep();
      passed.push(name);
      console.log(`PASS ${name}${evidence ? `  ${evidence}` : ""}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push(name);
      console.log(`FAIL ${name}  ${message.split("\n")[0]}`);
    }
  };

  // cbm 0.12 starts a per-user background daemon that outlives the CLI call.
  let daemonsBefore = new Set();

  try {
    await mkdir(cacheDir, { recursive: true });
    await mkdir(join(repoDir, "src"), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await cp(join(root, "src"), join(repoDir, "src"), { recursive: true });
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-qm", "fixture"]);

    process.env.CBM_CACHE_DIR = cacheDir;
    // Both outrank the temp cache / force a real probe, so drop them for this run.
    delete process.env.PI_CBM_CACHE_DIR;
    delete process.env.PI_CBM_SKIP_VERSION_CHECK;
    useBinary(binary);
    daemonsBefore = cbmDaemonPids();

    const cbm = new CbmClient();
    const coordinator = new IndexCoordinator({ cacheDirectory: cacheDir });
    const projects = new ProjectService(cbm, { autoIndexNonGitDirectories: false }, coordinator);
    const output = new OutputService();
    const symbols = new SymbolService(cbm, projects, output);
    const trace = new TraceService(cbm, projects, output, symbols);
    const query = new QueryService(cbm, projects, output, trace);
    const ctx = { cwd: repoDir };
    let project = "";

    console.log(`cbm live smoke: ${binary}`);
    console.log(`  cache ${cacheDir}\n  repo  ${repoDir}`);

    await step("index", async () => {
      const result = await projects.indexCurrentRepo(repoDir);
      assert.equal(result.status, "indexed", `index did not run: ${JSON.stringify(result)}`);
      assert.ok(result.project, "index result has no project name");
      project = result.project;
      return `project=${result.project} nodes=${result.nodes ?? "?"} edges=${result.edges ?? "?"}`;
    });

    await step("search_graph", async () => {
      const { details } = await query.executeQueryTool("Search results", "search_graph", { name_pattern: SYMBOL, limit: 5 }, ctx);
      const rows = details.data?.results;
      assert.ok(Array.isArray(rows) && rows.length > 0, `no search_graph rows: ${JSON.stringify(details.data)}`);
      const hit = rows.find((row) => row.name === SYMBOL);
      assert.ok(hit, `${SYMBOL} not in ${rows.length} row(s)`);
      return `${rows.length} row(s), qn=${hit.qualified_name}`;
    });

    await step("resolve_symbol", async () => {
      const { details } = await symbols.resolve({ name: SYMBOL }, ctx);
      const data = details.data;
      assert.equal(data?.total_candidates, 1, `expected 1 candidate, got ${JSON.stringify(data?.candidates)}`);
      assert.equal(data.ambiguous, false, "candidate is ambiguous");
      return `qn=${data.candidates[0].qualified_name} file=${data.candidates[0].file_path}`;
    });

    await step("read_symbol", async () => {
      const { details } = await symbols.read({ name: SYMBOL }, ctx);
      const data = details.data;
      assert.ok(data?.resolved, `read_symbol did not resolve one symbol: ${JSON.stringify(data)}`);
      assert.ok(typeof data.source === "string" && data.source.includes(SYMBOL), "read_symbol returned no source");
      return `${data.source.split("\n").length} source line(s) from ${data.file_path}`;
    });

    for (const direction of ["inbound", "outbound"]) {
      await step(`trace_path ${direction}`, async () => {
        const { details } = await trace.trace({ function_name: SYMBOL, mode: "calls", direction, depth: 2 }, ctx);
        const nodes = direction === "inbound" ? details.data?.callers : details.data?.callees;
        assert.ok(Array.isArray(nodes) && nodes.length > 0, `no ${direction} nodes: ${JSON.stringify(details.data)}`);
        return `${nodes.length} node(s), first=${nodes[0].qualified_name}`;
      });
    }

    await step("search_code", async () => {
      const { details } = await query.executeQueryTool("Search results", "search_code", { pattern: "resolveCbmBinary", limit: 10 }, ctx);
      const rows = details.data?.results;
      assert.ok(Array.isArray(rows) && rows.length > 0, `no search_code rows: ${JSON.stringify(details.data)}`);
      return `${rows.length} match(es), first=${rows[0].qualified_name}`;
    });

    await step("get_architecture", async () => {
      const { details } = await query.executeQueryTool("Architecture", "get_architecture", {}, ctx);
      const labels = details.data?.node_labels;
      assert.ok(Array.isArray(labels) && labels.length > 0, `no node labels: ${JSON.stringify(details.data)}`);
      return `${labels.length} label(s), nodes=${details.data.total_nodes ?? "?"}`;
    });

    await step("query_graph", async () => {
      const { details } = await query.queryGraph({ query: "MATCH (f:Function) RETURN f.name, f.file_path LIMIT 3" }, ctx);
      const rows = details.data?.rows;
      assert.ok(Array.isArray(rows) && rows.length > 0, `no query_graph rows: ${JSON.stringify(details.data)}`);
      return `${rows.length} row(s), columns=${details.data.columns.join(",")}`;
    });

    await step("detect_changes", async () => {
      await appendFile(join(repoDir, EDITED_FILE), "\n// live-smoke marker\n");
      const { details } = await query.executeQueryTool("Changes", "detect_changes", {}, ctx);
      const data = details.data;
      const files = Array.isArray(data?.changed_files) ? data.changed_files : [];
      assert.ok(files.includes(EDITED_FILE), `changed_files ${JSON.stringify(files)} does not include ${EDITED_FILE}`);
      return `${files.length} changed file(s), ${Array.isArray(data.impacted) ? data.impacted.length : 0} impacted (${data.index_freshness ?? "no freshness line"})`;
    });

    await step("project from outside cwd, no project", async () => {
      const message = await projects.resolveProject(undefined, outsideDir).then(
        (name) => assert.fail(`resolved "${name}" instead of failing`),
        (error) => (error instanceof Error ? error.message : String(error)),
      );
      assert.ok(message.includes("No indexed project matches"), `not an actionable error: ${message}`);
      assert.ok(message.includes("absolute path"), `error does not ask for the repo's absolute path: ${message}`);
      return message.split(";")[0];
    });

    await step("project from outside cwd, absolute path", async () => {
      const resolved = await projects.resolveProject(repoDir, outsideDir);
      assert.equal(resolved, project, `resolved ${resolved}, expected ${project}`);
      return `project=${resolved}`;
    });

    if (!oldBinary) {
      skipped.push("version gate");
      console.log("SKIP version gate  (set CBM_BIN_OLD=/path/to/codebase-memory-mcp 0.9.x to check the too-old error)");
    } else {
      await step("version gate (too-old binary)", async () => {
        useBinary(oldBinary);
        try {
          const result = await cbm.callTool("list_projects", {});
          assert.fail(`too-old binary was accepted: ${JSON.stringify(result.data)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes("unsupported"), `expected a too-old error, got: ${message}`);
          return message.split(";")[0];
        } finally {
          useBinary(binary);
        }
      });
    }
  } finally {
    stopStartedDaemons(daemonsBefore, cacheDir);
    await sleep(300);
    await removeTempDir(workdir);
  }

  const total = passed.length + failed.length + skipped.length;
  console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"}: ${passed.length}/${total - skipped.length} checks passed${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}`);
  if (failed.length > 0) {
    console.log(`failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  return result.stdout.trim();
}

function cbmDaemonPids() {
  const ps = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  const pids = new Set();
  for (const line of (ps.stdout ?? "").split("\n")) {
    if (!line.includes("--cbm-daemon-internal")) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (pid > 0) pids.add(pid);
  }
  return pids;
}

/** Stop only the daemons this run started, and only those on its temp cache. */
function stopStartedDaemons(before, cacheDir) {
  for (const pid of cbmDaemonPids()) {
    if (before.has(pid)) continue;
    try {
      // No /proc (e.g. macOS): the before/after diff is all we have to go on.
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`CBM_CACHE_DIR=${cacheDir}`)) continue;
    } catch {}
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

/** The daemon can re-create its cache dir, so give a removed dir one retry. */
async function removeTempDir(dir) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
      await sleep(300);
    }
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
