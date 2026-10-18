import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { consumeCbmVersionWarning } from "../cbm/version.js";
import type { CbmServices } from "../pi-tools/definitions.js";
import { selectedToolNames, unknownAllowlistEntries } from "../pi-tools/registry.js";
import { codebaseMemoryPrompt } from "./prompt.js";

const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const AUTO_REFRESH_INTERVAL_MS = resolveAutoRefreshIntervalMs();

function resolveAutoRefreshIntervalMs(): number {
  const configured = process.env.PI_CBM_AUTO_REFRESH_INTERVAL_MS?.trim() || process.env.CBM_AUTO_REFRESH_INTERVAL_MS?.trim();
  if (!configured) return DEFAULT_AUTO_REFRESH_INTERVAL_MS;

  const parsed = Number(configured);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_DELAY_MS ? parsed : DEFAULT_AUTO_REFRESH_INTERVAL_MS;
}

type SessionResources = Pick<ExtensionContext, "cwd" | "signal" | "ui">;

function readSessionResources(ctx: ExtensionContext): SessionResources | undefined {
  try {
    return {
      cwd: ctx.cwd,
      signal: ctx.signal,
      ui: ctx.ui,
    };
  } catch {
    // A session_start handler from an old runner can resume after reload and
    // receive a context that has already been invalidated.
    return undefined;
  }
}

export function registerLifecycle(pi: ExtensionAPI, services: CbmServices) {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  // Monotonically increasing session generation. Bumped synchronously on every
  // session start and shutdown so that interval callbacks already queued or
  // still awaiting from a previous session can bail out before using old
  // session-bound resources.
  let sessionGeneration = 0;
  // The session generation that currently owns an in-flight index, used to keep
  // a single active index per session without leaking state across sessions.
  let inFlightGeneration: number | undefined;
  // Compatibility and allowlist warnings are captured once and re-appended to
  // every status line so the periodic refresh does not hide them.
  let versionWarning: string | undefined;
  let allowlistWarning: string | undefined;

  function reportStatus(session: SessionResources, text: string) {
    if (versionWarning === undefined) versionWarning = consumeCbmVersionWarning();
    const warning = [allowlistWarning, versionWarning].filter(Boolean).join("; ");
    session.ui.setStatus("codebase-memory", warning ? `${text} ⚠ ${warning}` : text);
  }

  async function indexCurrentRepo(session: SessionResources, generation: number) {
    if (generation !== sessionGeneration) return; // stale session: skip
    if (inFlightGeneration === generation || session.signal?.aborted) return;

    inFlightGeneration = generation;
    try {
      const result = await services.projects.indexCurrentRepo(session.cwd, session.signal);
      if (generation !== sessionGeneration) return; // session changed mid-run
      if (result.status === "skipped") {
        reportStatus(session, `cbm skipped: ${result.reason}`);
        return;
      }

      const nodes = typeof result.nodes === "number" ? ` · ${result.nodes} nodes` : "";
      const edges = typeof result.edges === "number" ? ` · ${result.edges} edges` : "";
      reportStatus(session, `cbm ${result.project}${nodes}${edges}`);
    } catch (error) {
      if (generation !== sessionGeneration) return;
      const reason = error instanceof Error && error.message ? `: ${error.message}` : "";
      reportStatus(session, `cbm index failed${reason}`);
    } finally {
      if (inFlightGeneration === generation) inFlightGeneration = undefined;
    }
  }

  pi.on("before_agent_start", (event) => {
    const active = new Set(pi.getActiveTools());
    if (!selectedToolNames().some((name) => active.has(name))) return;
    return { systemPrompt: event.systemPrompt + codebaseMemoryPrompt() };
  });

  pi.on("session_start", (_event, ctx) => {
    const session = readSessionResources(ctx);
    if (!session) return;

    services.settings.reload();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;

    const generation = sessionGeneration + 1;
    sessionGeneration = generation;

    const unknown = unknownAllowlistEntries();
    allowlistWarning = unknown.length > 0 ? `PI_CBM_TOOLS ignored unknown tool name(s): ${unknown.join(", ")}` : undefined;

    void indexCurrentRepo(session, generation);
    refreshTimer = setInterval(() => {
      void indexCurrentRepo(session, generation);
    }, AUTO_REFRESH_INTERVAL_MS);
  });

  pi.on("session_shutdown", () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    // Invalidate synchronously so already-queued/running callbacks from this
    // session give up instead of updating old session-bound resources.
    sessionGeneration += 1;
  });
}
