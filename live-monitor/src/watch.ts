// ----------------------------------------------------------------------------
// File reading
// ----------------------------------------------------------------------------

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from "fs";
import { basename, join } from "path";
import { CODEX_SESSION_DIRS, PROJECTS_DIR, SEED_MTIME_WINDOW_MS } from "./config.ts";
import { isCodexFile, transcriptAdapter } from "./transcripts.ts";
import { parseLine } from "./parse.ts";
import { detailCache, emit, fileState, observeCache, ring, sessions, subagentMeta } from "./state.ts";
import { SubagentPath } from "./types.ts";
import { log } from "./util.ts";

const adapters = new Map<string, (raw: string) => string | null>();

export function slugOf(path: string): string {
  // .../.claude/projects/<slug>/<file>.jsonl → <slug>
  // (also works for nested subagent paths: <slug>/<sessionId>/subagents/agent-*.jsonl)
  const parts = path.split("/");
  const i = parts.lastIndexOf("projects");
  return i >= 0 && parts[i + 1] ? parts[i + 1] : basename(path);
}

export function subagentPathOf(path: string): SubagentPath | undefined {
  const m = path.match(/\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/);
  return m ? { parentSessionId: m[1], agentId: m[2] } : undefined;
}

// Load the sibling agent-<id>.meta.json ({agentType, description, toolUseId})
// once per agent. On failure (meta not written yet) we retry on the next read —
// only success is cached.
export function loadSubagentMeta(path: string, sub: SubagentPath) {
  if (subagentMeta.has(sub.agentId)) return;
  try {
    const raw = readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8");
    const o = JSON.parse(raw);
    if (o && typeof o === "object") {
      subagentMeta.set(sub.agentId, {
        ...(typeof o.agentType === "string" ? { agentType: o.agentType } : {}),
        ...(typeof o.description === "string" ? { description: o.description } : {}),
        ...(typeof o.toolUseId === "string" ? { toolUseId: o.toolUseId } : {}),
      });
      // Meta arriving late changes Task↔agent linking → rebuild on next request.
      detailCache.delete(sub.parentSessionId);
      observeCache.delete(sub.parentSessionId);
    }
  } catch {
    // meta file missing/unreadable — retry on next append
  }
}

// Read appended bytes from `path` starting at the stored offset; parse whole
// lines, buffering any partial trailing line. `broadcast` controls SSE emit.
export function readAppended(path: string, broadcast: boolean) {
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    return; // file vanished
  }
  const size = st.size;
  let state = fileState.get(path);
  // Archiving moves a rollout; carry its offset and counters to the new path.
  if (!state && isCodexFile(path)) {
    for (const [oldPath, oldState] of fileState) {
      if (isCodexFile(oldPath) && basename(oldPath) === basename(path)) {
        state = oldState;
        fileState.set(path, state);
        const adapter = adapters.get(oldPath);
        if (adapter) adapters.set(path, adapter);
        fileState.delete(oldPath);
        adapters.delete(oldPath);
        break;
      }
    }
  }
  if (!state) {
    state = { offset: 0, partial: "" };
    fileState.set(path, state);
  }
  // Truncation / rotation: offset beyond current size → reset to end (transcripts
  // only grow; a smaller size means the file was replaced — don't replay).
  if (state.offset > size) {
    state.offset = size;
    state.partial = "";
    return;
  }
  if (state.offset === size) return;

  let adapt = adapters.get(path);
  if (!adapt) {
    adapt = transcriptAdapter(path);
    // An old rollout registered at EOF can resume later. Recover metadata and
    // cumulative baseline without emitting historical usage a second time.
    if (isCodexFile(path) && state.offset > 0) {
      const previous = readFileSync(path).subarray(0, state.offset).toString("utf8");
      for (const line of previous.split("\n")) if (line) adapt(line);
    }
    adapters.set(path, adapt);
  }
  const slug = slugOf(path);
  const sub = subagentPathOf(path);
  if (sub) loadSubagentMeta(path, sub);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const CHUNK = 1 << 20; // 1 MiB
    let pos = state.offset;
    let buf = state.partial;
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const b = Buffer.allocUnsafe(len);
      const n = readSync(fd, b, 0, len, pos);
      if (n <= 0) break;
      pos += n;
      buf += b.toString("utf8", 0, n);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          const normalized = adapt(line);
          const r = normalized ? parseLine(normalized, slug, sub) : null;
          if (r) emit(r.ev, broadcast, r.line);
        }
      }
    }
    state.offset = pos;
    state.partial = buf;
  } catch (e) {
    log("read error", path, e);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

// Seed a file by parsing ALL of its lines (v2.2). Tail-only seeding (v1) made
// non-live sessions look truncated: plugin/hook/skill evidence lives in the
// system entries at the START of a transcript, so any session not tailed live
// showed an empty loading panel and undercounted prompts/usage. Full parse is
// a one-time startup cost; the per-session line store stays bounded by
// SESSION_LINE_MAX. Sets offset to EOF so live reads only pick up new appends.
export function seedFile(path: string) {
  readAppended(path, false);
}

function listClaudeFiles(): string[] {
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch (e) {
    // Either provider may be absent on this machine.
    return out;
  }
  for (const d of dirs) {
    const dir = join(PROJECTS_DIR, d);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(".jsonl")) {
        out.push(join(dir, f));
        continue;
      }
      // Nested subagent transcripts: <projectDir>/<sessionId>/subagents/agent-*.jsonl
      // (Claude Code ≥2.1.x writes Task/Agent transcripts here; their lines carry
      // the parent sessionId + isSidechain:true + agentId, so they merge into the
      // parent session on ingest — see subagentPathOf for the path fallback).
      //
      // DECISION (task #11, requirement 4): subagent usage IS included in the
      // parent session's aggregate totals (updateAgg), because it is additive
      // real API spend: verified on real 2.1.170 data that parent transcripts
      // contain ZERO isSidechain assistant lines when subagents/*.jsonl exist —
      // the parent only holds the Task tool_use/tool_result text, never the
      // sub-agent's message.usage. This also matches historical behavior, where
      // legacy inline sidechain lines flowed into the same totals. Per-node
      // double counting is prevented at chain level (collectSidechainChains)
      // and by /api/observe's selfTok excluding sidechain lines.
      const sub = join(dir, f, "subagents");
      try {
        if (!statSync(sub).isDirectory()) continue;
        for (const sf of readdirSync(sub)) {
          if (sf.endsWith(".jsonl")) out.push(join(sub, sf));
        }
      } catch {
        // not a directory / no subagents — ignore
      }
    }
  }
  return out;
}

export function listJsonlFiles(): string[] {
  const out = listClaudeFiles();
  const seen = new Set<string>();
  const walk = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl") && !seen.has(entry.name)) {
          seen.add(entry.name);
          out.push(path);
        }
      }
    } catch { /* Codex need not be installed; rescan discovers dirs created later. */ }
  };
  for (const dir of CODEX_SESSION_DIRS) walk(dir);
  return out;
}

export function firstScan() {
  const files = listJsonlFiles();
  const now = Date.now();
  // Sort by mtime ascending so newest files are seeded last → ring ends with newest.
  const withMtime = files
    .map((p) => {
      try {
        return { p, m: statSync(p).mtimeMs };
      } catch {
        return { p, m: 0 };
      }
    })
    .sort((a, b) => a.m - b.m);
  let seeded = 0;
  for (const { p, m } of withMtime) {
    if (now - m <= SEED_MTIME_WINDOW_MS) {
      seedFile(p);
      seeded++;
    } else {
      // Old file: don't seed content, but record offset at EOF so future appends stream.
      try {
        fileState.set(p, { offset: statSync(p).size, partial: "" });
      } catch {}
    }
  }
  log(`first scan: ${files.length} files, seeded ${seeded} (<=48h), ${ring.length} events, ${sessions.size} sessions`);
}

// Periodic rescan: pick up brand-new files (and new dirs) that fs.watch missed.
export function rescan() {
  try {
    const files = listJsonlFiles();
    for (const p of files) {
      if (!fileState.has(p)) {
        // New file appeared. If small/recent, seed its tail; else start at EOF.
        try {
          const st = statSync(p);
          if (Date.now() - st.mtimeMs <= SEED_MTIME_WINDOW_MS) {
            readAppended(p, true);
            // New sessions must appear in already-connected dashboards.
          } else {
            fileState.set(p, { offset: st.size, partial: "" });
          }
        } catch {}
      } else {
        readAppended(p, true);
      }
    }
  } catch (e) {
    log("rescan error", e);
  }
}

// Recursive watch. On any change to a .jsonl, read its appended bytes.
export function startWatch() {
  for (const root of [PROJECTS_DIR, ...CODEX_SESSION_DIRS]) {
    if (!existsSync(root)) continue;
    try {
      watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const name = filename.toString();
        if (!name.endsWith(".jsonl")) return;
        const path = join(root, name);
        try {
          if (existsSync(path)) readAppended(path, true);
        } catch (e) {
          log("watch handler error", path, e);
        }
      });
      log("watching (recursive):", root);
    } catch (e) {
      log("recursive watch failed, relying on periodic rescan:", e);
    }
  }
}

// Historical project links may target sessions outside the startup window.
export function loadCodexSession(id: string) {
  if (!id.startsWith("codex:") || sessions.has(id)) return;
  const suffix = id.slice(6);
  const path = listJsonlFiles().find(p => isCodexFile(p) &&
    (basename(p, ".jsonl") === suffix || basename(p, ".jsonl").endsWith("-" + suffix)));
  if (!path) return;
  fileState.delete(path);
  adapters.delete(path);
  seedFile(path);
}
