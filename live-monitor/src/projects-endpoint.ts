import { transcriptLines } from "./transcripts.ts";
// ----------------------------------------------------------------------------
// Projects index over a `days` window — self-contained on-disk scan.
// The in-memory `sessions` map only covers SEED_MTIME_WINDOW_MS (~48h), so a
// parameterless fold shows barely two days of history. This mirrors
// buildStatsJSON's disk scan (patterns COPIED, not refactored) to rebuild
// FoldSession-shaped per-session aggregates for the requested window, then reuses
// the pure `foldProjects` grouping. Windows up to 60 days are supported.
// ----------------------------------------------------------------------------




import { readFileSync, statSync } from "fs";
import { basename } from "path";
import { PROJECTS_DIR, STATS_DAY_MS, startedAt } from "./config.ts";
import { FoldSession, foldProjects } from "./projects.ts";
import { Usage } from "./types.ts";
import { addUsage, emptyUsage, log, projectName, usageFrom } from "./util.ts";
import { listJsonlFiles, subagentPathOf } from "./watch.ts";

export const PROJECTS_CACHE_MS = 60_000;
export const projectsCache = new Map<number, { at: number; sig: string; json: string }>();

export interface ProjSessAgg {
  sessionId: string;
  provider?: "claude" | "codex";
  slug: string;
  cwd: string;
  firstTs: string;
  lastTs: string;
  prompts: number;
  usage: Usage;
  tools: Record<string, number>;
  skills: Record<string, number>;
}

export function buildProjectsJSON(days: number): string {
  const t0 = Date.now();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startMs = today.getTime() - (days - 1) * STATS_DAY_MS;

  // ----- candidate files (mtime in window) + cheap cache signature -----
  const files: Array<{ path: string; mtime: number; size: number }> = [];
  let maxM = 0;
  let totalB = 0;
  for (const p of listJsonlFiles()) {
    try {
      const st = statSync(p);
      if (st.mtimeMs < startMs) continue;
      files.push({ path: p, mtime: st.mtimeMs, size: st.size });
      if (st.mtimeMs > maxM) maxM = st.mtimeMs;
      totalB += st.size;
    } catch {
      // vanished between listing and stat — skip
    }
  }
  const sig = `${files.length}:${Math.round(maxM)}:${totalB}`;
  const hit = projectsCache.get(days);
  if (hit && hit.sig === sig && t0 - hit.at < PROJECTS_CACHE_MS) return hit.json;

  // ----- per-session aggregation, keyed by (parent) sessionId -----
  const bySession = new Map<string, ProjSessAgg>();
  const get = (sid: string, slug: string): ProjSessAgg => {
    let a = bySession.get(sid);
    if (!a) {
      a = {
        sessionId: sid,
        slug,
        cwd: "",
        firstTs: "",
        lastTs: "",
        prompts: 0,
        usage: emptyUsage(),
        tools: {},
        skills: {},
      };
      bySession.set(sid, a);
    }
    return a;
  };

  for (const f of files) {
    const sub = subagentPathOf(f.path);
    const rel = f.path.slice(PROJECTS_DIR.length + 1);
    const slug = rel.split("/")[0] ?? "";
    const fallbackSid = sub?.parentSessionId ?? basename(f.path, ".jsonl");
    let raw: string;
    try {
      raw = readFileSync(f.path, "utf8");
    } catch {
      continue;
    }

    for (const line of transcriptLines(f.path, raw)) {
      if (!line) continue;
      const isAsst = line.includes('"type":"assistant"');
      const isUser = !isAsst && line.includes('"type":"user"');
      if (!isAsst && !isUser) continue;
      if (isAsst && !line.includes('"usage"') && !line.includes('"tool_use"')) continue;
      if (isUser && (line.includes('"tool_use_id"') || line.includes('"isMeta":true'))) continue;

      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o || typeof o !== "object") continue;
      const ts = typeof o.timestamp === "string" ? o.timestamp : "";
      const tsMs = Date.parse(ts);
      if (!Number.isFinite(tsMs) || tsMs < startMs) continue; // outside window
      const sid = sub?.parentSessionId ?? (typeof o.sessionId === "string" ? o.sessionId : fallbackSid);
      const msg = o.message;
      const agg = get(sid, slug);
      agg.provider = o.provider === "codex" ? "codex" : "claude";

      if (typeof o.cwd === "string" && o.cwd.length > 0) agg.cwd = o.cwd;
      if (agg.firstTs === "" || ts < agg.firstTs) agg.firstTs = ts;
      if (agg.lastTs === "" || ts > agg.lastTs) agg.lastTs = ts;

      if (isAsst) {
        const u = usageFrom(msg?.usage);
        if (u) addUsage(agg.usage, u);
        if (Array.isArray(msg?.content)) {
          for (const b of msg.content) {
            if (!b || typeof b !== "object" || b.type !== "tool_use" || typeof b.name !== "string") continue;
            if (b.name === "Skill" && b.input && typeof b.input === "object") {
              const sn = b.input.skill ?? b.input.command ?? b.input.name;
              if (typeof sn === "string") agg.skills[sn] = (agg.skills[sn] || 0) + 1;
            } else if ((b.name === "Task" || b.name === "Agent") && b.input && typeof b.input === "object") {
              // agents excluded from topTools (mirrors in-memory fold: tools+skills only)
            } else if (b.name.startsWith("mcp__")) {
              // mcp calls excluded from topTools
            } else {
              agg.tools[b.name] = (agg.tools[b.name] || 0) + 1;
            }
          }
        }
        continue;
      }

      // user line — count real human prompts only (sub-agent inputs excluded).
      if (sub || o.isSidechain === true) continue;
      const content = msg?.content;
      let ptext = "";
      if (typeof content === "string") {
        ptext = content;
      } else if (Array.isArray(content)) {
        let hasToolResult = false;
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "tool_result") {
            hasToolResult = true;
            break;
          }
          if (b.type === "text" && typeof b.text === "string") ptext += b.text + "\n";
        }
        if (hasToolResult) continue;
      } else {
        continue;
      }
      if (!ptext.trim()) continue;
      agg.prompts++;
    }
  }

  // ----- shape FoldSession[] and reuse the pure grouping fold -----
  const foldSessions: FoldSession[] = [];
  for (const a of bySession.values()) {
    if (a.firstTs === "" && a.lastTs === "") continue; // never contributed
    foldSessions.push({
      sessionId: a.sessionId,
      provider: a.provider,
      project: projectName(a.cwd, a.slug),
      cwd: a.cwd || undefined,
      firstTs: a.firstTs || a.lastTs,
      lastTs: a.lastTs || a.firstTs,
      prompts: a.prompts,
      usage: a.usage,
      tools: a.tools,
      skills: a.skills,
    });
  }

  const envelope = foldProjects(foldSessions, startedAt);
  const json = JSON.stringify({ ...envelope, days });
  projectsCache.set(days, { at: Date.now(), sig, json });
  log(`projects(${days}d): ${files.length} files (${(totalB / 1e6).toFixed(1)}MB) in ${Date.now() - t0}ms`);
  return json;
}

