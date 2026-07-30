// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------



import { homedir } from "os";
import { join } from "path";

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.MONITOR_PORT ?? 8722);
export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export const RING_MAX = 5000;
export const SEED_MTIME_WINDOW_MS = 48 * 60 * 60 * 1000; // only seed files modified in last 48h
export const RESCAN_INTERVAL_MS = 15_000; // periodic fallback rescan for new files
export const KEEPALIVE_MS = 25_000;
// Bun.serve idle timeout, in SECONDS (Bun's unit; 0 disables, 255 is the max).
// Must stay above KEEPALIVE_MS or Bun closes idle SSE streams before the
// heartbeat fires -- "[Bun.serve]: request timed out after 10 seconds".
export const SSE_IDLE_TIMEOUT_S = 120;
export const TEXT_SNIPPET_LEN = 140;

// v2: per-session bounded line store for on-demand SessionDetail (tree/attribution).
export const SESSION_LINE_MAX = 4000; // last N parsed lines per session
export const SESSION_ACTIVE_MS = 7 * 24 * 60 * 60 * 1000; // only retain sessions active in last 7d
export const LABEL_LEN = 100; // tree node label cap
export const EVIDENCE_LEN = 80; // auto-loading evidence cap (contract: ≤120, we keep ≤80)
export const TREE_MAX_NODES = 2000; // whole-tree node cap
export const AGENT_MAX_DEPTH = 4; // sidechain nesting depth cap
export const AGENT_MAX_NODES = 50; // nodes per agent subtree cap

// v4/projects: one day in ms — shared by /api/stats and /api/projects windows.
export const STATS_DAY_MS = 86_400_000;

export const startedAt = new Date().toISOString();
