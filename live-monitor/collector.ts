// Live Claude Code session monitor — collector (server half).
// Bun + TypeScript, ZERO npm dependencies. Single file.
//
// Watches ~/.claude/projects/**/*.jsonl (Claude Code transcripts), parses each
// appended line incrementally, keeps a ring buffer of MonitorEvents + per-session
// aggregates, and serves an HTTP + SSE API on 127.0.0.1:8722 (MONITOR_PORT override).
//
// See CONTRACT.md for the interface. Field names below were verified against real
// transcripts in ~/.claude/projects/ (see README.md "Observed transcript fields").

import { watch, existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import { createServer } from "http";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { foldProjects } from "./projects.ts";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const HOST = "127.0.0.1";
const PORT = Number(process.env.MONITOR_PORT ?? 8722);
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
// Resolve the directory of this module across runtimes: Bun exposes
// `import.meta.dir`, Node 20.11+ exposes `import.meta.dirname`, and older Node
// falls back to deriving it from `import.meta.url`.
const HERE =
  (import.meta as { dir?: string; dirname?: string }).dir ??
  (import.meta as { dir?: string; dirname?: string }).dirname ??
  dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");

const RING_MAX = 5000;
const SEED_MTIME_WINDOW_MS = 48 * 60 * 60 * 1000; // only seed files modified in last 48h
const RESCAN_INTERVAL_MS = 15_000; // periodic fallback rescan for new files
const KEEPALIVE_MS = 25_000;
const TEXT_SNIPPET_LEN = 140;

// v2: per-session bounded line store for on-demand SessionDetail (tree/attribution).
const SESSION_LINE_MAX = 4000; // last N parsed lines per session
const SESSION_ACTIVE_MS = 7 * 24 * 60 * 60 * 1000; // only retain sessions active in last 7d
const LABEL_LEN = 100; // tree node label cap
const EVIDENCE_LEN = 80; // auto-loading evidence cap (contract: ≤120, we keep ≤80)
const TREE_MAX_NODES = 2000; // whole-tree node cap
const AGENT_MAX_DEPTH = 4; // sidechain nesting depth cap
const AGENT_MAX_NODES = 50; // nodes per agent subtree cap

const startedAt = new Date().toISOString();

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
type Kind = "prompt" | "assistant" | "tool_use" | "tool_result" | "system";

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface MonitorEvent {
  id: number;
  ts: string;
  sessionId: string;
  project: string;
  kind: Kind;
  uuid?: string; // v2: transcript line uuid
  parentUuid?: string; // v2: transcript line parentUuid
  model?: string;
  usage?: Usage;
  tools?: string[];
  skill?: string;
  command?: string; // v2: slash command detected in a prompt
  rules?: string[]; // v2.4: rule files (.claude/rules/*.md) injected on a prompt line
  agent?: string; // v2: Task/Agent subagent_type
  sidechain?: boolean; // v2: line has isSidechain:true
  text?: string;
  cwd?: string; // v2.2: session working directory (from transcript line)
}

interface SessionAgg {
  sessionId: string;
  project: string;
  cwd?: string; // v2.2: last-seen working directory of the session
  firstTs: string;
  lastTs: string;
  prompts: number;
  events: number;
  models: Record<string, number>;
  usage: Usage;
  tools: Record<string, number>;
  skills: Record<string, number>;
  commands: Record<string, number>; // v2
  rules: Record<string, number>; // v2.4
  agents: Record<string, number>; // v2
}

// v2: raw-ish parsed line retained per session for on-demand tree/attribution.
// Richer than MonitorEvent: keeps ordered tool_use blocks with their ids/inputs.
interface ToolUseBlock {
  id: string; // toolu_… (may be "" if absent)
  name: string;
  input: any;
}
interface SessionLine {
  ts: string;
  uuid?: string;
  parentUuid?: string;
  kind: Kind;
  model?: string;
  usage?: Usage;
  sidechain: boolean;
  agentId?: string; // v3.1: sub-agent id (from line field or subagents/agent-<id>.jsonl path)
  isMeta: boolean;
  command?: string; // slash command on a prompt line
  reminders: string[]; // system-reminder / hook evidence strings from user content
  text?: string; // prompt/tool_result/assistant text snippet
  toolUses: ToolUseBlock[]; // assistant tool_use blocks, in order
  toolResultFor?: string; // tool_use_id this line answers (tool_result lines)
  resultBytes?: number; // byte size of tool_result content
}

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------
const ring: MonitorEvent[] = [];
let nextId = 1;
const sessions = new Map<string, SessionAgg>();

// v2: per-session bounded line store + lazily-built SessionDetail cache.
const sessionLines = new Map<string, SessionLine[]>();
const detailCache = new Map<string, { at: number; json: string }>();
// v3: cached /api/observe payloads (spec entity model), same invalidation.
const observeCache = new Map<string, { at: number; json: string }>();

// Per-file incremental read state: byte offset + partial trailing line buffer.
const fileState = new Map<string, { offset: number; partial: string }>();

// v3.1 (task #11): sub-agent metadata harvested from subagents/agent-<id>.meta.json.
// toolUseId is the parent Task tool_use id — the exact link between a dedicated
// subagent transcript and the Task node in the parent session (verified on disk).
interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
}
const subagentMeta = new Map<string, SubagentMeta>(); // agentId → meta

// SSE clients
const clients = new Set<(ev: MonitorEvent) => void>();

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------
function log(...args: unknown[]) {
  console.error("[collector]", ...args);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Decode a project name. Prefer basename of `cwd` when present; otherwise decode
// the dir slug. Slugs look like "-Users-javierbenavides-others-foo-bar" — the
// leading "-" and path separators became "-", so take the last segment.
function decodeProjectFromSlug(slug: string): string {
  // Strip a single leading dash, split on dashes, take last non-empty segment.
  const parts = slug.replace(/^-+/, "").split("-").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : slug;
}

function projectName(cwd: unknown, slug: string): string {
  if (typeof cwd === "string" && cwd.length) {
    const b = basename(cwd);
    if (b) return b;
  }
  return decodeProjectFromSlug(slug);
}

function snippet(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, TEXT_SNIPPET_LEN);
}

function clip(s: string, n: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

function usageFrom(u: any): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
function addUsage(dst: Usage, src?: Usage) {
  if (!src) return;
  dst.input += src.input;
  dst.output += src.output;
  dst.cacheRead += src.cacheRead;
  dst.cacheWrite += src.cacheWrite;
}
function scaleUsage(u: Usage | undefined, f: number): Usage | undefined {
  if (!u) return undefined;
  return {
    input: Math.round(u.input * f),
    output: Math.round(u.output * f),
    cacheRead: Math.round(u.cacheRead * f),
    cacheWrite: Math.round(u.cacheWrite * f),
  };
}

// Extract a slash command from user prompt content. Verified real format:
//   <command-name>/clear</command-name> (+ <command-message>, <command-args>).
// Fallback: a leading "/word" token in plain prompt text. Must be followed by
// whitespace or end-of-text — NOT another "/" — so absolute paths like
// "/Users/…" or "/tmp/foo" at the start of a prompt aren't misread as commands.
function detectCommand(text: string): string | undefined {
  const tag = text.match(/<command-name>\s*(\/?[\w:-]+)\s*<\/command-name>/);
  if (tag) return tag[1].startsWith("/") ? tag[1] : "/" + tag[1];
  const m = text.match(/^\s*(\/[a-zA-Z][\w:-]*)(?=\s|$)/);
  if (m) return m[1];
  return undefined;
}

// v2.4: detect rule files injected into a prompt turn. Claude Code rules live
// in .claude/rules/*.md (project scope) or ~/.claude/rules/*.md (user scope)
// and are auto-loaded into context like CLAUDE.md memory. No verified local
// transcript sample yet, so match conservative path evidence only:
// ".claude/rules/<name>.md" appearing in prompt/system-reminder content.
function detectRules(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\.claude\/rules\/([\w.-]+(?:\/[\w.-]+)*\.md)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < 32) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

// Collect auto-loading evidence strings from a user prompt: <system-reminder>
// first lines and hook markers. Returns short evidence snippets.
function detectReminders(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const c = clip(s, EVIDENCE_LEN);
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  };
  const sr = text.match(/<system-reminder>([\s\S]*?)(?:<\/system-reminder>|$)/g);
  if (sr) for (const block of sr) {
    const inner = block.replace(/<\/?system-reminder>/g, "");
    const firstLine = inner.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    push("system-reminder: " + firstLine);
  }
  for (const marker of ["UserPromptSubmit hook", "PreToolUse:", "PostToolUse:", "SessionStart hook"]) {
    if (text.includes(marker)) push(marker);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Parsing — adapted to REAL transcript shapes (verified against live files):
//   line = { type, message?, timestamp, sessionId, cwd, ... }
//   assistant: message.model, message.usage.{input_tokens,output_tokens,
//              cache_read_input_tokens,cache_creation_input_tokens},
//              message.content[] blocks of type thinking|text|tool_use(name,input)
//   user: message.content is a string (prompt) OR an array containing
//         {type:"tool_result", tool_use_id, content, is_error}
//   Non-event line types (last-prompt, mode, permission-mode, ai-title,
//   file-history-snapshot, attachment, summary, system w/o info) are skipped.
// ----------------------------------------------------------------------------
// Parse result carries BOTH the MonitorEvent-shaped payload (for ring/SSE/agg)
// and the richer SessionLine (for on-demand tree/attribution).
interface ParseResult {
  ev: Omit<MonitorEvent, "id">;
  line: SessionLine;
}

function parseLine(raw: string, slug: string, sub?: SubagentPath): ParseResult | null {
  let o: any;
  try {
    o = JSON.parse(raw);
  } catch {
    return null; // malformed — skip silently
  }
  if (!o || typeof o !== "object") return null;

  const type = o.type;
  const ts: string = typeof o.timestamp === "string" ? o.timestamp : startedAt;
  // task #11: lines in subagents/agent-*.jsonl carry the PARENT sessionId
  // (verified on disk); the directory name is the authoritative fallback when
  // the field is absent — attribution to the parent session must never depend
  // on the line alone.
  const sessionId: string =
    typeof o.sessionId === "string" ? o.sessionId : sub?.parentSessionId ?? "unknown";
  const project = projectName(o.cwd, slug);
  const msg = o.message;
  const uuid: string | undefined = typeof o.uuid === "string" ? o.uuid : undefined;
  const parentUuid: string | undefined = typeof o.parentUuid === "string" ? o.parentUuid : undefined;
  // Dedicated subagent transcripts are sidechains even if a line omits the flag.
  const sidechain: boolean = o.isSidechain === true || sub !== undefined;
  const agentId: string | undefined =
    typeof o.agentId === "string" ? o.agentId : sub?.agentId;
  const cwd: string | undefined =
    typeof o.cwd === "string" && o.cwd.length ? o.cwd : undefined;

  const mk = (
    ev: Omit<MonitorEvent, "id">,
    extra: Partial<SessionLine>,
  ): ParseResult => ({
    ev: {
      ...ev,
      ...(uuid ? { uuid } : {}),
      ...(parentUuid ? { parentUuid } : {}),
      ...(sidechain ? { sidechain: true } : {}),
      ...(cwd ? { cwd } : {}),
    },
    line: {
      ts,
      uuid,
      parentUuid,
      kind: ev.kind,
      model: ev.model,
      usage: ev.usage,
      sidechain,
      ...(agentId ? { agentId } : {}),
      isMeta: o.isMeta === true,
      text: ev.text,
      reminders: [],
      toolUses: [],
      ...extra,
    },
  });

  if (type === "assistant") {
    const model: string | undefined = typeof msg?.model === "string" ? msg.model : undefined;
    const usage = usageFrom(msg?.usage);
    const tools: string[] = [];
    const toolUses: ToolUseBlock[] = [];
    let skill: string | undefined;
    let agent: string | undefined;
    let text: string | undefined;
    if (Array.isArray(msg?.content)) {
      for (const b of msg.content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "tool_use" && typeof b.name === "string") {
          tools.push(b.name);
          toolUses.push({
            id: typeof b.id === "string" ? b.id : "",
            name: b.name,
            input: b.input,
          });
          if (b.name === "Skill" && b.input && typeof b.input === "object") {
            // Real format: input.skill (verified). Keep command/name fallbacks.
            const sn = b.input.skill ?? b.input.command ?? b.input.name;
            if (typeof sn === "string") skill = sn;
          }
          if ((b.name === "Task" || b.name === "Agent") && b.input && typeof b.input === "object") {
            const at = b.input.subagent_type ?? b.input.subagentType ?? b.input.agent;
            if (typeof at === "string") agent = at;
          }
        } else if (b.type === "text" && typeof b.text === "string" && !text) {
          text = snippet(b.text);
        }
      }
    }
    return mk(
      {
        ts, sessionId, project,
        kind: "assistant",
        ...(model ? { model } : {}),
        ...(usage ? { usage } : {}),
        ...(tools.length ? { tools } : {}),
        ...(skill ? { skill } : {}),
        ...(agent ? { agent } : {}),
        ...(text ? { text } : {}),
      },
      { model, usage, toolUses },
    );
  }

  if (type === "user") {
    const content = msg?.content;
    if (o.isMeta === true) {
      // Meta/injected user lines (hook feedback, CLAUDE.md context, caveats).
      // Not real prompts — but they ARE auto-loaded context. Harvest evidence.
      let joined = "";
      if (typeof content === "string") joined = content;
      else if (Array.isArray(content)) {
        for (const b of content) {
          if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
            joined += b.text + "\n";
          }
        }
      }
      const evs = detectReminders(joined);
      if (evs.length === 0) {
        const first = joined.trim().split("\n")[0];
        if (first) evs.push(clip(first, EVIDENCE_LEN));
      }
      if (evs.length === 0) return null;
      return mk({ ts, sessionId, project, kind: "system" }, { reminders: evs });
    }
    // Array content: if it contains tool_result blocks → kind:tool_result
    if (Array.isArray(content)) {
      let toolResultFor: string | undefined;
      let resultBytes: number | undefined;
      let text: string | undefined;
      let joined = "";
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "tool_result") {
          if (!toolResultFor && typeof b.tool_use_id === "string") toolResultFor = b.tool_use_id;
          const c = b.content;
          let cstr = "";
          if (typeof c === "string") cstr = c;
          else if (Array.isArray(c)) {
            cstr = c
              .map((x: any) => (x?.type === "text" && typeof x.text === "string" ? x.text : ""))
              .join("");
          }
          resultBytes = (resultBytes ?? 0) + Buffer.byteLength(cstr, "utf8");
          if (!text && cstr) text = snippet(cstr);
        } else if (b.type === "text" && typeof b.text === "string") {
          joined += b.text + "\n";
          if (!text) text = snippet(b.text);
        }
      }
      if (toolResultFor !== undefined) {
        return mk(
          { ts, sessionId, project, kind: "tool_result", ...(text ? { text } : {}) },
          { toolResultFor, resultBytes },
        );
      }
      // array of only text blocks → treat as prompt
      const command = detectCommand(joined);
      const reminders = detectReminders(joined);
      const rules = detectRules(joined);
      for (const r of rules) reminders.push(`rule:${r}`);
      return mk(
        {
          ts, sessionId, project, kind: "prompt",
          ...(command ? { command } : {}),
          ...(rules.length ? { rules } : {}),
          ...(text ? { text } : {}),
        },
        { command, reminders },
      );
    }
    if (typeof content === "string") {
      const s = snippet(content);
      if (!s) return null; // skip empty
      const command = detectCommand(content);
      const reminders = detectReminders(content);
      const rules = detectRules(content);
      for (const r of rules) reminders.push(`rule:${r}`);
      return mk(
        {
          ts, sessionId, project, kind: "prompt",
          ...(command ? { command } : {}),
          ...(rules.length ? { rules } : {}),
          text: s,
        },
        { command, reminders },
      );
    }
    return null;
  }

  if (type === "system") {
    // Harvest hook/plugin evidence from hook summaries (e.g. stop_hook_summary,
    // whose hookInfos[].command paths reveal which plugins are firing).
    const evs: string[] = [];
    if (Array.isArray(o.hookInfos)) {
      const event =
        typeof o.subtype === "string" ? o.subtype.replace(/_hook_summary$/, "") : "hook";
      for (const hi of o.hookInfos) {
        const cmd = typeof hi?.command === "string" ? hi.command : "";
        if (!cmd) continue;
        const pm = cmd.match(/plugins\/([\w.-]+)[\/"']/);
        const script = (cmd.match(/([\w-]+\.(?:sh|mjs|cjs|js|py|ts))/) ?? [])[1];
        if (pm) evs.push(`plugin:${pm[1]} ${event} hook${script ? " " + script : ""}`);
        else if (cmd.includes("CLAUDE_PLUGIN_ROOT"))
          evs.push(`plugin:${script ?? "plugin"} ${event} hook`);
        else if (script) evs.push(`hook:${event} ${script}`);
      }
    }
    // Surface system lines that carry useful info (hook output/errors/evidence).
    if (o.hasOutput === true || o.hookErrors || o.preventedContinuation === true || evs.length > 0) {
      let text: string | undefined;
      if (typeof o.hookAdditionalContext === "string") text = snippet(o.hookAdditionalContext);
      else if (typeof o.subtype === "string") text = snippet(o.subtype);
      return mk({ ts, sessionId, project, kind: "system", ...(text ? { text } : {}) }, { reminders: evs });
    }
    return null;
  }

  // last-prompt, mode, permission-mode, ai-title, file-history-snapshot,
  // attachment, summary, and anything else → not a monitor event.
  return null;
}

// ----------------------------------------------------------------------------
// Aggregation
// ----------------------------------------------------------------------------
function updateAgg(ev: MonitorEvent) {
  let a = sessions.get(ev.sessionId);
  if (!a) {
    a = {
      sessionId: ev.sessionId,
      project: ev.project,
      firstTs: ev.ts,
      lastTs: ev.ts,
      prompts: 0,
      events: 0,
      models: {},
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      tools: {},
      skills: {},
      commands: {},
      rules: {},
      agents: {},
    };
    sessions.set(ev.sessionId, a);
  }
  a.project = ev.project || a.project;
  if (ev.cwd) a.cwd = ev.cwd; // last-seen working directory wins
  if (ev.ts < a.firstTs) a.firstTs = ev.ts;
  if (ev.ts > a.lastTs) a.lastTs = ev.ts;
  a.events++;
  if (ev.kind === "prompt") a.prompts++;
  if (ev.model) a.models[ev.model] = (a.models[ev.model] ?? 0) + 1;
  if (ev.usage) {
    a.usage.input += ev.usage.input;
    a.usage.output += ev.usage.output;
    a.usage.cacheRead += ev.usage.cacheRead;
    a.usage.cacheWrite += ev.usage.cacheWrite;
  }
  if (ev.tools) for (const t of ev.tools) a.tools[t] = (a.tools[t] ?? 0) + 1;
  if (ev.skill) a.skills[ev.skill] = (a.skills[ev.skill] ?? 0) + 1;
  if (ev.command) a.commands[ev.command] = (a.commands[ev.command] ?? 0) + 1;
  if (ev.rules) for (const r of ev.rules) a.rules[r] = (a.rules[r] ?? 0) + 1;
  if (ev.agent) a.agents[ev.agent] = (a.agents[ev.agent] ?? 0) + 1;
}

// v2: retain the parsed line in the per-session bounded store; invalidate the
// cached SessionDetail so it rebuilds on the next request.
function storeSessionLine(sessionId: string, line: SessionLine) {
  let arr = sessionLines.get(sessionId);
  if (!arr) {
    arr = [];
    sessionLines.set(sessionId, arr);
  }
  arr.push(line);
  if (arr.length > SESSION_LINE_MAX) arr.splice(0, arr.length - SESSION_LINE_MAX);
  detailCache.delete(sessionId);
  observeCache.delete(sessionId);
}

// v2: drop line stores + caches for sessions inactive > 7 days.
function pruneSessionStores() {
  const now = Date.now();
  for (const [id, a] of sessions) {
    const last = Date.parse(a.lastTs);
    if (Number.isFinite(last) && now - last > SESSION_ACTIVE_MS) {
      sessionLines.delete(id);
      detailCache.delete(id);
      observeCache.delete(id);
    }
  }
}

function emit(partial: Omit<MonitorEvent, "id">, broadcast: boolean, line?: SessionLine) {
  const ev: MonitorEvent = { id: nextId++, ...partial };
  ring.push(ev);
  if (ring.length > RING_MAX) ring.shift();
  updateAgg(ev);
  if (line) storeSessionLine(ev.sessionId, line);
  if (broadcast) {
    for (const send of clients) {
      try {
        send(ev);
      } catch (e) {
        log("client send error", e);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// File reading
// ----------------------------------------------------------------------------
function slugOf(path: string): string {
  // .../.claude/projects/<slug>/<file>.jsonl → <slug>
  // (also works for nested subagent paths: <slug>/<sessionId>/subagents/agent-*.jsonl)
  const parts = path.split("/");
  const i = parts.lastIndexOf("projects");
  return i >= 0 && parts[i + 1] ? parts[i + 1] : basename(path);
}

// task #11: <projectDir>/<sessionId>/subagents/agent-<id>.jsonl → ids; null for
// ordinary top-level session transcripts.
interface SubagentPath {
  parentSessionId: string;
  agentId: string;
}
function subagentPathOf(path: string): SubagentPath | undefined {
  const m = path.match(/\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/);
  return m ? { parentSessionId: m[1], agentId: m[2] } : undefined;
}

// Load the sibling agent-<id>.meta.json ({agentType, description, toolUseId})
// once per agent. On failure (meta not written yet) we retry on the next read —
// only success is cached.
function loadSubagentMeta(path: string, sub: SubagentPath) {
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
function readAppended(path: string, broadcast: boolean) {
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    return; // file vanished
  }
  const size = st.size;
  let state = fileState.get(path);
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
          const r = parseLine(line, slug, sub);
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
function seedFile(path: string) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  const slug = slugOf(path);
  const sub = subagentPathOf(path);
  if (sub) loadSubagentMeta(path, sub);
  try {
    // Read full file (seed only — first scan). Use sync read for simplicity.
    const fd = openSync(path, "r");
    const size = st.size;
    const b = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, b, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    closeSync(fd);
    const content = b.toString("utf8", 0, read);
    const lines = content.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const r = parseLine(line, slug, sub);
      if (r) emit(r.ev, false, r.line); // no broadcast during seed
    }
    fileState.set(path, { offset: read, partial: "" });
  } catch (e) {
    log("seed error", path, e);
  }
}

function listJsonlFiles(): string[] {
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch (e) {
    log("cannot read projects dir", PROJECTS_DIR, e);
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

function firstScan() {
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
function rescan() {
  try {
    const files = listJsonlFiles();
    for (const p of files) {
      if (!fileState.has(p)) {
        // New file appeared. If small/recent, seed its tail; else start at EOF.
        try {
          const st = statSync(p);
          if (Date.now() - st.mtimeMs <= SEED_MTIME_WINDOW_MS) {
            seedFile(p);
            // Broadcast nothing during seed; but a genuinely new active file will
            // continue to append and stream live from here.
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
function startWatch() {
  try {
    watch(PROJECTS_DIR, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (!name.endsWith(".jsonl")) return;
      const path = join(PROJECTS_DIR, name);
      try {
        if (!existsSync(path)) return;
        readAppended(path, true);
      } catch (e) {
        log("watch handler error", path, e);
      }
    });
    log("watching (recursive):", PROJECTS_DIR);
  } catch (e) {
    log("recursive watch failed, relying on periodic rescan:", e);
  }
}

// ----------------------------------------------------------------------------
// v2: SessionDetail builder — deduplicated counts w/ token attribution,
// auto-vs-invoked classification, and a prompt-rooted invocation tree.
// Lazily built from the per-session bounded line store; cached until the
// store changes (storeSessionLine invalidates detailCache on new lines).
// ----------------------------------------------------------------------------

// mcp__<server>__<tool> → server group name ("<server>"); undefined if not MCP.
function mcpServer(name: string): string | undefined {
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  return m ? m[1] : undefined;
}

interface CountUsage {
  count: number;
  usage: Usage;
}
type CountMap = Record<string, CountUsage>;

function bump(map: CountMap, key: string, by: number, usage?: Usage) {
  let e = map[key];
  if (!e) {
    e = map[key] = { count: 0, usage: emptyUsage() };
  }
  e.count += by;
  addUsage(e.usage, usage);
}

interface AutoLoad {
  type: "memory" | "rule" | "skill" | "command" | "plugin" | "hook" | "mcp";
  name: string;
  evidence: string;
}
interface InvokedLoad {
  type: "skill" | "command" | "agent" | "tool" | "mcp";
  name: string;
  count: number;
}

interface TreeNode {
  kind: "prompt" | "assistant" | "tool" | "skill" | "command" | "agent";
  name: string;
  ts: string;
  label: string;
  usage?: Usage;
  durationMs?: number;
  resultBytes?: number;
  children?: TreeNode[];
}

// v2.4: estimate a rule file's context load (tokens ≈ bytes/4) by statting it
// under the session cwd (.claude/rules/) or user scope (~/.claude/rules/).
// Best-effort: 0 when the file can't be found from this machine.
const ruleSizeCache = new Map<string, number>();
function ruleTokenEstimate(cwd: string | undefined, name: string): Usage | undefined {
  const key = (cwd ?? "") + "|" + name;
  let tok = ruleSizeCache.get(key);
  if (tok === undefined) {
    tok = 0;
    const candidates = [
      ...(cwd ? [join(cwd, ".claude", "rules", name)] : []),
      join(homedir(), ".claude", "rules", name),
    ];
    for (const p of candidates) {
      try {
        tok = Math.round(statSync(p).size / 4);
        break;
      } catch {}
    }
    ruleSizeCache.set(key, tok);
  }
  return tok > 0 ? { input: tok, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined;
}

// Classify a single reminder evidence string into an auto-load entry.
function classifyReminder(ev: string): AutoLoad {
  // Structured prefixes emitted by our own harvesters take priority.
  const pm = ev.match(/^plugin:([\w.-]+)\s*(.*)$/);
  if (pm) return { type: "plugin", name: pm[1], evidence: ev };
  const hm = ev.match(/^hook:(\S+)\s*(.*)$/);
  if (hm) return { type: "hook", name: hm[2] ? `${hm[1]} ${hm[2]}` : hm[1], evidence: ev };
  const rm = ev.match(/^rule:(\S+)/);
  if (rm) return { type: "rule", name: rm[1], evidence: ev };
  const low = ev.toLowerCase();
  if (low.includes(".claude/rules/")) {
    const rp = ev.match(/\.claude\/rules\/([\w.-]+(?:\/[\w.-]+)*\.md)/);
    return { type: "rule", name: rp ? rp[1] : "rule", evidence: ev };
  }
  if (low.includes("claude.md") || low.includes("memory")) {
    const name = ev.includes("CLAUDE.md") ? "CLAUDE.md" : "memory";
    return { type: "memory", name, evidence: ev };
  }
  if (low.includes("hook") || low.startsWith("pretooluse") || low.startsWith("posttooluse")) {
    return { type: "hook", name: ev.split(/[:\n]/)[0].trim() || "hook", evidence: ev };
  }
  if (low.includes("skill")) return { type: "skill", name: "skill", evidence: ev };
  if (low.includes("plugin")) return { type: "plugin", name: "plugin", evidence: ev };
  if (low.includes("mcp")) return { type: "mcp", name: "mcp", evidence: ev };
  return { type: "memory", name: "context", evidence: ev };
}

function inputSummary(name: string, input: any): string {
  if (input == null) return name;
  try {
    if (typeof input === "string") return clip(input, LABEL_LEN);
    if (typeof input === "object") {
      // Prefer the most human field per common tool shapes.
      const pick =
        input.command ?? input.description ?? input.file_path ?? input.path ??
        input.pattern ?? input.query ?? input.prompt ?? input.skill ?? input.url;
      if (typeof pick === "string") return clip(pick, LABEL_LEN);
      return clip(JSON.stringify(input), LABEL_LEN);
    }
  } catch {}
  return name;
}

// Determine the tool_use block's tree kind + display name.
function toolNodeKind(b: ToolUseBlock): { kind: TreeNode["kind"]; name: string } {
  if (b.name === "Skill") {
    const sn = b.input?.skill ?? b.input?.command ?? b.input?.name;
    return { kind: "skill", name: typeof sn === "string" ? sn : "Skill" };
  }
  if (b.name === "Task" || b.name === "Agent") {
    const at = b.input?.subagent_type ?? b.input?.subagentType ?? b.input?.agent;
    return { kind: "agent", name: typeof at === "string" ? at : b.name };
  }
  return { kind: "tool", name: b.name };
}

// v2.3: per-sub-agent dispatch summary (its own tokens/cost/tools/duration).
interface AgentDispatch {
  agent: string;
  ts: string;
  model?: string;
  usage?: Usage;
  costUSD?: number;
  toolCount: number;
  durationMs?: number;
  label: string;
}

function buildSessionDetail(sessionId: string): string | null {
  const agg = sessions.get(sessionId);
  const lines = sessionLines.get(sessionId);
  if (!agg || !lines || lines.length === 0) return null;

  // ----- index: tool_use_id → { result line, durationMs, resultBytes } -----
  // Map tool_use id → the emitting tool_use ts + block, then match results.
  const toolUseTs = new Map<string, number>(); // id → ts ms
  const resultFor = new Map<string, { ts: number; bytes: number }>();
  for (const ln of lines) {
    const tms = Date.parse(ln.ts);
    for (const tu of ln.toolUses) {
      if (tu.id) toolUseTs.set(tu.id, Number.isFinite(tms) ? tms : NaN);
    }
    if (ln.toolResultFor) {
      resultFor.set(ln.toolResultFor, {
        ts: Number.isFinite(tms) ? tms : NaN,
        bytes: ln.resultBytes ?? 0,
      });
    }
  }
  const durationOf = (id: string): number | undefined => {
    const a = toolUseTs.get(id);
    const r = resultFor.get(id);
    if (a === undefined || !r) return undefined;
    const d = r.ts - a;
    return Number.isFinite(d) && d >= 0 ? d : undefined;
  };

  // ----- scope tracking for token attribution -----
  // Active scopes: current slash-command (until next prompt), plus a stack of
  // open Skill scopes (innermost wins), plus agent sidechain (sidechain:true).
  // We attribute each assistant message's usage to the innermost active scope.
  const tools: CountMap = {};
  const skills: CountMap = {};
  const commands: CountMap = {};
  const rules: CountMap = {};
  const agents: CountMap = {};
  const mcp: CountMap = {};

  const invokedTools = new Map<string, number>();
  const invokedSkills = new Map<string, number>();
  const invokedCommands = new Map<string, number>();
  const invokedAgents = new Map<string, number>();
  const invokedMcp = new Map<string, number>();
  const autoMap = new Map<string, AutoLoad>(); // key: type|name

  let curCommand: string | undefined; // slash command active in current prompt turn
  const skillStack: string[] = []; // open Skill scopes (innermost last)
  // Open skill scope closes when its tool_result arrives; track by tool_use id.
  const openSkillById = new Map<string, string>(); // tool_use id → skill name

  for (const ln of lines) {
    // Auto-load evidence from user/prompt reminders.
    for (const ev of ln.reminders) {
      const a = classifyReminder(ev);
      const k = a.type + "|" + a.name;
      if (!autoMap.has(k)) autoMap.set(k, a);
      // v2.4: rules — count every injection; attribute the estimated context
      // load (file size / 4) once per unique rule, mirroring skill/command maps.
      if (a.type === "rule" && a.name !== "rule") {
        const first = !(a.name in rules);
        bump(rules, a.name, 1, first ? ruleTokenEstimate(agg.cwd, a.name) : undefined);
      }
    }

    if (ln.kind === "prompt") {
      // New prompt turn: reset command scope.
      curCommand = ln.command;
      if (ln.command) {
        bump(commands, ln.command, 1);
        invokedCommands.set(ln.command, (invokedCommands.get(ln.command) ?? 0) + 1);
      }
      continue;
    }

    if (ln.kind === "tool_result") {
      // Closing a skill scope if this result answers an open Skill tool_use.
      if (ln.toolResultFor && openSkillById.has(ln.toolResultFor)) {
        const sn = openSkillById.get(ln.toolResultFor)!;
        const idx = skillStack.lastIndexOf(sn);
        if (idx >= 0) skillStack.splice(idx, 1);
        openSkillById.delete(ln.toolResultFor);
      }
      continue;
    }

    if (ln.kind === "assistant") {
      const usage = ln.usage;
      // Innermost active scope wins for whole-message attribution:
      //   sidechain(agent) > skill > command.
      if (ln.sidechain) {
        // Sidechain lines belong to an agent; we can't always know which agent
        // from the line alone — attribute to a synthetic "sidechain" agent
        // bucket only if no better name. Most agent naming happens at the Task
        // tool_use (handled below); here we credit usage to the last agent seen.
        // Fall through: still divide tool usage per block below.
      } else if (skillStack.length) {
        bump(skills, skillStack[skillStack.length - 1], 0, usage);
      } else if (curCommand) {
        bump(commands, curCommand, 0, usage);
      }

      // Per-tool attribution: split this message's usage across its tool_use
      // blocks (divide by block count) so tool sums ≈ real totals.
      const n = ln.toolUses.length;
      const share = n > 0 ? scaleUsage(usage, 1 / n) : undefined;
      for (const tu of ln.toolUses) {
        const { kind, name } = toolNodeKind(tu);
        const srv = mcpServer(tu.name);
        if (kind === "skill") {
          bump(skills, name, 1, share);
          invokedSkills.set(name, (invokedSkills.get(name) ?? 0) + 1);
          // Namespaced skill ("plugin:skill-name") → the plugin auto-loaded it.
          const ns = name.includes(":") ? name.split(":")[0] : undefined;
          if (ns) {
            const k = "plugin|" + ns;
            if (!autoMap.has(k))
              autoMap.set(k, { type: "plugin", name: ns, evidence: `skill ${name} invoked` });
          }
          // Open a skill scope until its tool_result.
          if (tu.id) openSkillById.set(tu.id, name);
          skillStack.push(name);
        } else if (kind === "agent") {
          bump(agents, name, 1, share);
          invokedAgents.set(name, (invokedAgents.get(name) ?? 0) + 1);
        } else if (srv) {
          bump(mcp, srv, 1, share);
          invokedMcp.set(srv, (invokedMcp.get(srv) ?? 0) + 1);
          // MCP tools are also real tool calls; count in tools map too.
          bump(tools, tu.name, 1, share);
          invokedTools.set(tu.name, (invokedTools.get(tu.name) ?? 0) + 1);
        } else {
          bump(tools, name, 1, share);
          invokedTools.set(name, (invokedTools.get(name) ?? 0) + 1);
        }
      }
      continue;
    }
  }

  // ----- sidechain chains: one per sub-agent invocation (v2.2) -----
  const chains = collectSidechainChains(lines);
  const dispatches: AgentDispatch[] = [];

  // ----- invocation tree: one root per prompt, chronological -----
  const roots: TreeNode[] = [];
  let cur: TreeNode | null = null;
  let nodeCount = 0;
  const capped = () => nodeCount >= TREE_MAX_NODES;

  for (const ln of lines) {
    if (ln.sidechain) continue; // sidechain lines summarized under agent nodes, not top-level
    if (ln.kind === "prompt") {
      const isCmd = !!ln.command;
      cur = {
        kind: isCmd ? "command" : "prompt",
        name: isCmd ? ln.command! : "",
        ts: ln.ts,
        label: clip(ln.text ?? "", LABEL_LEN),
        children: [],
      };
      roots.push(cur);
      nodeCount++;
      continue;
    }
    if (!cur) continue; // events before any prompt in the window — skip
    if (capped()) continue;

    if (ln.kind === "assistant") {
      // Assistant text step (only add a node if it carries usage or text).
      const textLabel = clip(ln.text ?? "", LABEL_LEN);
      if (ln.usage || textLabel) {
        const an: TreeNode = {
          kind: "assistant",
          name: ln.model ?? "",
          ts: ln.ts,
          label: textLabel,
          ...(ln.usage ? { usage: ln.usage } : {}),
          children: [],
        };
        cur.children!.push(an);
        nodeCount++;
      }
      const n = ln.toolUses.length;
      const share = n > 0 ? scaleUsage(ln.usage, 1 / n) : undefined;
      for (const tu of ln.toolUses) {
        if (capped()) break;
        const { kind, name } = toolNodeKind(tu);
        const node: TreeNode = {
          kind,
          name,
          ts: ln.ts,
          label: inputSummary(tu.name, tu.input),
          ...(share ? { usage: share } : {}),
        };
        const dur = tu.id ? durationOf(tu.id) : undefined;
        if (dur !== undefined) node.durationMs = dur;
        const r = tu.id ? resultFor.get(tu.id) : undefined;
        if (r && r.bytes) node.resultBytes = r.bytes;
        if (kind === "agent") {
          const chain = claimChain(chains, promptOf(tu.input), ln.ts, tu.id || undefined);
          if (chain) {
            const total = chainUsage(chain);
            if (total) node.usage = total; // sub-agent's own token cost
            const sub = chainSubtree(chain);
            if (sub.length) node.children = sub;
            const model = chainModel(chain);
            const dur = chainDurationMs(chain);
            dispatches.push({
              agent: name,
              ts: chain.rootTs,
              ...(model ? { model } : {}),
              ...(total ? { usage: total, costUSD: costUSD(model, total) } : {}),
              toolCount: chainToolCount(chain),
              ...(dur !== undefined ? { durationMs: dur } : {}),
              label: clip(promptOf(tu.input) || chain.promptText, LABEL_LEN),
            });
          }
        }
        cur.children!.push(node);
        nodeCount++;
      }
      continue;
    }
  }

  // Cap: truncate oldest prompts first if over TREE_MAX_NODES.
  while (nodeCount > TREE_MAX_NODES && roots.length > 1) {
    const dropped = roots.shift()!;
    nodeCount -= countNodes(dropped);
  }

  // Chains never claimed by an Agent tool_use in the retained window still
  // represent sub-agent work — surface them as dispatches too. Dedicated
  // subagent files know their agent type from meta.json (task #11).
  for (const c of chains) {
    if (c.claimed) continue;
    const total = chainUsage(c);
    const model = chainModel(c);
    const dur = chainDurationMs(c);
    dispatches.push({
      agent: (c.agentId && subagentMeta.get(c.agentId)?.agentType) || "(sidechain)",
      ts: c.rootTs,
      ...(model ? { model } : {}),
      ...(total ? { usage: total, costUSD: costUSD(model, total) } : {}),
      toolCount: chainToolCount(c),
      ...(dur !== undefined ? { durationMs: dur } : {}),
      label: clip(c.promptText, LABEL_LEN),
    });
  }
  dispatches.sort((a, b) => a.ts.localeCompare(b.ts));

  // ----- session cost + context-window estimates (v2.3) -----
  const usageByModel = new Map<string, Usage>();
  let lastCtx: { model: string; tokens: number; ts: string } | null = null;
  for (const ln of lines) {
    if (!ln.usage || !ln.model) continue;
    let u = usageByModel.get(ln.model);
    if (!u) {
      u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      usageByModel.set(ln.model, u);
    }
    u.input += ln.usage.input;
    u.output += ln.usage.output;
    u.cacheRead += ln.usage.cacheRead;
    u.cacheWrite += ln.usage.cacheWrite;
    if (!ln.sidechain) {
      // Current context ≈ what the last main-chain call read:
      // fresh input + cache read + cache write.
      lastCtx = {
        model: ln.model,
        tokens: ln.usage.input + ln.usage.cacheRead + ln.usage.cacheWrite,
        ts: ln.ts,
      };
    }
  }
  const byModel = [...usageByModel]
    .map(([model, u]) => ({ model, usage: u, costUSD: costUSD(model, u) }))
    .sort((a, b) => b.costUSD - a.costUSD);
  const byCategory = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const [model, u] of usageByModel) {
    const p = priceFor(model);
    byCategory.input += (u.input * p.input) / 1e6;
    byCategory.output += (u.output * p.output) / 1e6;
    byCategory.cacheRead += (u.cacheRead * p.input * 0.1) / 1e6;
    byCategory.cacheWrite += (u.cacheWrite * p.input * 1.25) / 1e6;
  }
  const totalUSD = byModel.reduce((s, m) => s + m.costUSD, 0);

  const auto = Array.from(autoMap.values());
  const invoked: InvokedLoad[] = [
    ...[...invokedSkills].map(([name, count]) => ({ type: "skill" as const, name, count })),
    ...[...invokedCommands].map(([name, count]) => ({ type: "command" as const, name, count })),
    ...[...invokedAgents].map(([name, count]) => ({ type: "agent" as const, name, count })),
    ...[...invokedMcp].map(([name, count]) => ({ type: "mcp" as const, name, count })),
    ...[...invokedTools].map(([name, count]) => ({ type: "tool" as const, name, count })),
  ];

  const detail = {
    sessionId: agg.sessionId,
    project: agg.project,
    ...(agg.cwd ? { cwd: agg.cwd } : {}),
    ...(lastCtx ? { context: lastCtx } : {}),
    cost: { totalUSD, byModel, byCategory },
    dispatches,
    firstTs: agg.firstTs,
    lastTs: agg.lastTs,
    prompts: agg.prompts,
    usage: agg.usage,
    tools,
    skills,
    commands,
    rules,
    agents,
    mcp,
    loading: { auto, invoked },
    tree: roots,
  };
  return JSON.stringify(detail);
}

function countNodes(n: TreeNode): number {
  let c = 1;
  if (n.children) for (const ch of n.children) c += countNodes(ch);
  return c;
}

// ----- sub-agent sidechain chains (v2.2, reworked for task #11) --------------
// Two sources, one chain per Task/Agent invocation:
//   • "file": dedicated <sessionId>/subagents/agent-<id>.jsonl transcripts
//     (Claude Code ≥2.1.x). Lines carry agentId, so grouping is exact and
//     robust under interleaved live tailing of concurrent agents.
//   • "inline": legacy isSidechain:true lines inside the parent transcript
//     (uuid→parentUuid walk; a chain starts at a sidechain prompt whose
//     parentUuid is missing or points outside the sidechain set).
// DOUBLE-COUNTING RULE: if the same agent run appears both ways (transitional
// versions), prefer the dedicated file — inline chains whose prompt matches a
// file chain's prompt are dropped. (Verified on disk: 2.1.170 parents contain
// ZERO inline sidechain lines, so in practice sources are disjoint.)
interface SidechainChain {
  rootTs: string;
  promptText: string;
  lines: SessionLine[];
  claimed: boolean;
  source: "file" | "inline"; // "file" = dedicated subagents/agent-*.jsonl
  agentId?: string; // set for source:"file"
}

function collectSidechainChains(lines: SessionLine[]): SidechainChain[] {
  const byAgent = new Map<string, SessionLine[]>();
  const inline: SessionLine[] = [];
  for (const ln of lines) {
    if (!ln.sidechain) continue;
    if (ln.agentId) {
      let arr = byAgent.get(ln.agentId);
      if (!arr) byAgent.set(ln.agentId, (arr = []));
      arr.push(ln);
    } else {
      inline.push(ln);
    }
  }
  const chains: SidechainChain[] = [];
  for (const [agentId, lns] of byAgent) {
    // Store order follows ingestion, not time (files seed/tail independently).
    lns.sort((a, b) => a.ts.localeCompare(b.ts));
    const prompt = lns.find((l) => l.kind === "prompt");
    chains.push({
      rootTs: lns[0].ts,
      promptText: prompt?.text ?? "",
      lines: lns,
      claimed: false,
      source: "file",
      agentId,
    });
  }
  const sidechainUuids = new Set<string>();
  for (const ln of inline) if (ln.uuid) sidechainUuids.add(ln.uuid);
  let cur: SidechainChain | null = null;
  for (const ln of inline) {
    const isRoot =
      ln.kind === "prompt" && (!ln.parentUuid || !sidechainUuids.has(ln.parentUuid));
    if (isRoot || !cur) {
      cur = { rootTs: ln.ts, promptText: ln.text ?? "", lines: [], claimed: false, source: "inline" };
      chains.push(cur);
    }
    cur.lines.push(ln);
  }
  // Apply the double-counting rule (prefer "file", drop matching "inline").
  const fileGuesses = chains
    .filter((c) => c.source === "file")
    .map((c) => c.promptText.slice(0, 60))
    .filter(Boolean);
  const out = chains.filter(
    (c) => c.source !== "inline" || !fileGuesses.some((g) => c.promptText.startsWith(g)),
  );
  out.sort((a, b) => a.rootTs.localeCompare(b.rootTs));
  return out;
}

function promptOf(input: unknown): string {
  const p = (input as { prompt?: unknown } | null)?.prompt;
  return typeof p === "string" ? p : "";
}

// Match an Agent tool_use to its sidechain chain. Precedence:
//   1. exact id link (task #11): the agent's meta.json toolUseId === tool_use id;
//   2. prompt-text match;
//   3. first unclaimed chain starting at/after the tool_use timestamp
//      (small slack for clock ordering);
//   4. first unclaimed chain.
function claimChain(
  chains: SidechainChain[],
  prompt: string,
  ts: string,
  toolUseId?: string,
): SidechainChain | null {
  if (toolUseId) {
    const exact = chains.find(
      (c) => !c.claimed && c.agentId && subagentMeta.get(c.agentId)?.toolUseId === toolUseId,
    );
    if (exact) {
      exact.claimed = true;
      return exact;
    }
  }
  const guess = prompt.slice(0, 60);
  let best: SidechainChain | null = null;
  if (guess) {
    best = chains.find((c) => !c.claimed && c.promptText.startsWith(guess)) ?? null;
  }
  if (!best) {
    const tMs = Date.parse(ts);
    best =
      chains.find((c) => {
        if (c.claimed) return false;
        const r = Date.parse(c.rootTs);
        return !Number.isFinite(tMs) || !Number.isFinite(r) || r >= tMs - 5_000;
      }) ?? null;
  }
  if (!best) best = chains.find((c) => !c.claimed) ?? null;
  if (best) best.claimed = true;
  return best;
}

// Sum the sub-agent's own token usage across its chain.
// ----- cost estimation (v2.3) ------------------------------------------------
// USD per 1M tokens. cacheRead = 0.1×input, cacheWrite = 1.25×input (API rules).
const MODEL_PRICING: Array<{ re: RegExp; input: number; output: number }> = [
  { re: /opus/i, input: 15, output: 75 },
  { re: /sonnet/i, input: 3, output: 15 },
  { re: /haiku/i, input: 1, output: 5 },
  { re: /fable/i, input: 3, output: 15 }, // placeholder until pricing published
];
const DEFAULT_PRICING = { input: 3, output: 15 };

function priceFor(model: string): { input: number; output: number } {
  for (const p of MODEL_PRICING) if (p.re.test(model)) return p;
  return DEFAULT_PRICING;
}

function costUSD(model: string, u: Usage): number {
  const p = priceFor(model);
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.input * 0.1 +
      u.cacheWrite * p.input * 1.25) /
    1e6
  );
}

// Most frequent model across a chain's assistant lines.
function chainModel(chain: SidechainChain): string {
  const counts = new Map<string, number>();
  for (const ln of chain.lines) {
    if (ln.model) counts.set(ln.model, (counts.get(ln.model) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [m, n] of counts) if (n > bestN) { best = m; bestN = n; }
  return best;
}

function chainToolCount(chain: SidechainChain): number {
  let n = 0;
  for (const ln of chain.lines) n += ln.toolUses.length;
  return n;
}

function chainDurationMs(chain: SidechainChain): number | undefined {
  const first = Date.parse(chain.rootTs);
  const last = Date.parse(chain.lines[chain.lines.length - 1]?.ts ?? "");
  return Number.isFinite(first) && Number.isFinite(last) && last >= first
    ? last - first
    : undefined;
}

function chainUsage(chain: SidechainChain): NonNullable<SessionLine["usage"]> | undefined {
  let total: NonNullable<SessionLine["usage"]> | undefined;
  for (const ln of chain.lines) {
    if (!ln.usage) continue;
    if (!total) total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    total.input += ln.usage.input;
    total.output += ln.usage.output;
    total.cacheRead += ln.usage.cacheRead;
    total.cacheWrite += ln.usage.cacheWrite;
  }
  return total;
}

// The sub-agent's own invocation tree: its task prompt first, then assistant
// steps + tool uses, chronological, bounded by AGENT_MAX_NODES.
function chainSubtree(chain: SidechainChain): TreeNode[] {
  const out: TreeNode[] = [];
  let count = 0;
  if (chain.promptText) {
    out.push({
      kind: "prompt",
      name: "",
      ts: chain.rootTs,
      label: clip(chain.promptText, LABEL_LEN),
    });
    count++;
  }
  for (const ln of chain.lines) {
    if (count >= AGENT_MAX_NODES) {
      out.push({ kind: "assistant", name: "", ts: ln.ts, label: "…truncated" });
      break;
    }
    if (ln.kind !== "assistant") continue;
    const textLabel = clip(ln.text ?? "", LABEL_LEN);
    if (textLabel || ln.usage) {
      out.push({
        kind: "assistant",
        name: ln.model ?? "",
        ts: ln.ts,
        label: textLabel,
        ...(ln.usage ? { usage: ln.usage } : {}),
      });
      count++;
    }
    for (const tu of ln.toolUses) {
      if (count >= AGENT_MAX_NODES) break;
      const { kind, name } = toolNodeKind(tu);
      out.push({ kind, name, ts: ln.ts, label: inputSummary(tu.name, tu.input) });
      count++;
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// v3: /api/observe — session-observability entity model (spec §2).
// One node per session (root) + one per sub-agent sidechain chain. Rules:
//   • selfTok / cost EXCLUDE descendants — rollups add upward from leaves.
//   • Every dyn TriggerEvent carries `by` (triggering node name).
//   • Agent dispatches appear BOTH as a dyn event on the parent (display-only)
//     and as a child node; token rollups must walk children, never dyn.
//   • pre[].tk is per-turn occupancy (estimated; est:true flags estimates).
//   • "used" is only claimed for mechanically observable kinds (spec §7.1c):
//     skill/command/plugin/mcp/tool. memory/hook rows carry observable:false
//     and are excluded from the waste stat.
// Decisions encoded here:
//   • selfTok = fresh input + output (cache excluded) so subtree sums stay
//     meaningful; cost uses full cache pricing via costUSD (spec §7.2 TBD).
//   • ctx = peak (input + cacheRead + cacheWrite) across the node's own calls.
//   • dur = wall span of the node's own lines (activeDur split: spec §7.3 TBD).
// ----------------------------------------------------------------------------
type ObsKind =
  | "system" | "memory" | "skill" | "command" | "plugin" | "mcp" | "hook" | "tool" | "agent";

interface ObsResource {
  k: ObsKind;
  n: string;
  tk: number;
  used: boolean;
  est?: boolean; // tk is an estimate (chars/4), not a measurement
  observable?: boolean; // false → excluded from waste (memory/hook)
}
interface ObsTrigger {
  k: ObsKind;
  n: string;
  tk: number;
  at: string;
  by: string;
}
// Full decomposition of a node's peak context window (`ctx`). All measured from
// transcript usage/bytes except `base` (derived from the turn-1 window floor)
// and `prompts` (residual). Segments sum to `ctx` when nothing was compacted;
// `overflow` records cumulative history that has been evicted out of the window.
interface CtxBreakdown {
  ctx: number;         // peak window = input + cacheRead + cacheWrite (ground truth)
  base: number;        // system prompt + tool schemas + memory/CLAUDE.md — turn-1 floor
  assistant: number;   // Σ usage.output — assistant text + tool-call JSON (measured)
  toolResults: number; // Σ resultBytes/4 — file reads, bash, skill bodies, sub-agent reports (measured)
  prompts: number;     // ctx − base − assistant − toolResults (user input + estimation slack)
  overflow: number;    // max(0, measured − ctx) — history compacted/evicted out of window
}
interface ObsNode {
  id: string;
  type: "session" | "agent";
  name: string;
  label: string;
  model?: string;
  src?: "file" | "inline"; // agent nodes: dedicated subagents/*.jsonl vs legacy inline sidechain
  parentId: string | null;
  start?: string;
  dur?: number;
  selfTok: number;
  cost: number;
  ctx: number;
  turns: number;
  tools: Record<string, number>;
  pre: ObsResource[];
  dyn: ObsTrigger[];
  ctxBreakdown?: CtxBreakdown; // full window decomposition (spec §7.5)
  toolTokens?: Record<string, number>; // tool/skill/agent name → Σ result tokens (bytes/4)
}

const OBS_CAP = 200_000;
const estTok = (s: string | undefined): number =>
  s ? Math.max(1, Math.round(s.length / 4)) : 0;

// Self metrics over a set of lines (one node's own turns only).
function obsSelf(lns: SessionLine[]) {
  let selfTok = 0;
  let cost = 0;
  let ctx = 0;
  let turns = 0;
  const tools: Record<string, number> = {};
  let firstMs = NaN;
  let lastMs = NaN;
  for (const ln of lns) {
    const t = Date.parse(ln.ts);
    if (Number.isFinite(t)) {
      if (!Number.isFinite(firstMs)) firstMs = t;
      lastMs = t;
    }
    if (ln.kind !== "assistant") continue;
    if (ln.usage) {
      selfTok += ln.usage.input + ln.usage.output;
      if (ln.model) cost += costUSD(ln.model, ln.usage);
      ctx = Math.max(ctx, ln.usage.input + ln.usage.cacheRead + ln.usage.cacheWrite);
      turns++;
    }
    for (const tu of ln.toolUses) tools[tu.name] = (tools[tu.name] ?? 0) + 1;
  }
  const dur =
    Number.isFinite(firstMs) && Number.isFinite(lastMs) && lastMs >= firstMs
      ? lastMs - firstMs
      : undefined;
  return { selfTok, cost, ctx, turns, tools, dur };
}

// Full context-window decomposition for one node's own lines. See CtxBreakdown.
// `base` is the turn-1 window (system + tools + memory) minus that turn's own
// user prompt; the remaining buckets accumulate across the node's turns and the
// residual `prompts` absorbs user input we can't size precisely (prompt text is
// clipped in the transcript) plus cache/estimation slack.
function obsBreakdown(
  lns: SessionLine[],
  resultFor: Map<string, { ts: number; bytes: number }>,
): CtxBreakdown {
  let ctx = 0;
  let firstCtx = 0;
  let firstPromptTok = 0;
  let assistant = 0;
  let toolResults = 0;
  let sawTurn = false;
  let sawPrompt = false;
  const seenResult = new Set<string>(); // avoid double-counting a shared tool_result
  for (const ln of lns) {
    if (ln.kind === "prompt" && !sawPrompt) {
      firstPromptTok = estTok(ln.text);
      sawPrompt = true;
    }
    if (ln.kind === "tool_result" && ln.toolResultFor) {
      if (!seenResult.has(ln.toolResultFor)) {
        seenResult.add(ln.toolResultFor);
        toolResults += Math.round((ln.resultBytes ?? 0) / 4);
      }
    }
    if (ln.kind !== "assistant" || !ln.usage) continue;
    assistant += ln.usage.output;
    const w = ln.usage.input + ln.usage.cacheRead + ln.usage.cacheWrite;
    ctx = Math.max(ctx, w);
    if (!sawTurn) {
      firstCtx = w;
      sawTurn = true;
    }
  }
  const base = Math.max(0, firstCtx - firstPromptTok);
  const measured = base + assistant + toolResults;
  const prompts = Math.max(0, ctx - measured);
  const overflow = Math.max(0, measured - ctx);
  return { ctx, base, assistant, toolResults, prompts, overflow };
}

// Runtime tokens returned by each tool/skill/agent = its tool_result byte size /4.
// Keyed by display name (skill/agent name, else the raw tool name).
function obsToolTokens(
  lns: SessionLine[],
  resultFor: Map<string, { ts: number; bytes: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ln of lns) {
    if (ln.kind !== "assistant") continue;
    for (const tu of ln.toolUses) {
      if (!tu.id) continue;
      const r = resultFor.get(tu.id);
      if (!r || !r.bytes) continue;
      const { name } = toolNodeKind(tu);
      out[name] = (out[name] ?? 0) + Math.round(r.bytes / 4);
    }
  }
  return out;
}

// Map an AutoLoad classification to an ObsKind (identical names, typed).
const OBS_OBSERVABLE = new Set<ObsKind>(["skill", "command", "plugin", "mcp", "tool"]);

// dyn events for one node's own lines: skill body loads + command invocations.
function obsDyn(
  lns: SessionLine[],
  by: string,
  resultFor: Map<string, { ts: number; bytes: number }>,
): ObsTrigger[] {
  const out: ObsTrigger[] = [];
  for (const ln of lns) {
    if (ln.kind === "prompt" && ln.command) {
      out.push({ k: "command", n: ln.command, tk: estTok(ln.text), at: ln.ts, by });
      continue;
    }
    if (ln.kind !== "assistant") continue;
    for (const tu of ln.toolUses) {
      const { kind, name } = toolNodeKind(tu);
      if (kind === "skill") {
        const r = tu.id ? resultFor.get(tu.id) : undefined;
        // Body cost ≈ tool_result bytes / 4 (one-time, per invocation).
        out.push({
          k: "skill",
          n: name,
          tk: r?.bytes ? Math.round(r.bytes / 4) : 0,
          at: ln.ts,
          by,
        });
      } else {
        const srv = mcpServer(tu.name);
        if (srv) out.push({ k: "mcp", n: tu.name, tk: 0, at: ln.ts, by });
      }
    }
  }
  return out;
}

function buildObserveSnapshot(sessionId: string): string | null {
  const cached = observeCache.get(sessionId);
  if (cached) return cached.json;
  const agg = sessions.get(sessionId);
  const lines = sessionLines.get(sessionId);
  if (!agg || !lines || lines.length === 0) return null;

  const main = lines.filter((l) => !l.sidechain);
  const chains = collectSidechainChains(lines);

  // tool_use id → result (for skill body sizes + durations).
  const resultFor = new Map<string, { ts: number; bytes: number }>();
  for (const ln of lines) {
    if (ln.toolResultFor) {
      const t = Date.parse(ln.ts);
      resultFor.set(ln.toolResultFor, {
        ts: Number.isFinite(t) ? t : NaN,
        bytes: ln.resultBytes ?? 0,
      });
    }
  }

  // ----- session-scoped invoked sets (registry "used" is a session question) -----
  const invokedNames = new Set<string>(); // "<kind>|<base name>"
  for (const ln of lines) {
    if (ln.kind === "prompt" && ln.command) invokedNames.add("command|" + ln.command);
    if (ln.kind !== "assistant") continue;
    for (const tu of ln.toolUses) {
      const { kind, name } = toolNodeKind(tu);
      if (kind === "skill") {
        invokedNames.add("skill|" + name);
        const ns = name.includes(":") ? name.split(":")[0] : "";
        if (ns) invokedNames.add("plugin|" + ns);
      } else if (kind === "agent") {
        invokedNames.add("agent|" + name);
      } else {
        invokedNames.add("tool|" + tu.name);
        const srv = mcpServer(tu.name);
        if (srv) invokedNames.add("mcp|" + srv);
      }
    }
  }

  // ----- pre[]: boot context evidence from reminders (deduped) -----
  // task #11: scoped per node — root gets main-chain evidence only; each agent
  // node gets the reminders from its own transcript lines. `used` stays a
  // session-wide question (invokedNames covers all lines).
  const buildPre = (lns: SessionLine[]): ObsResource[] => {
    const preMap = new Map<string, ObsResource>();
    for (const ln of lns) {
      for (const ev of ln.reminders) {
        const a = classifyReminder(ev);
        const k = a.type as ObsKind;
        const key = k + "|" + a.name;
        const observable = OBS_OBSERVABLE.has(k);
        const prev = preMap.get(key);
        const tk = estTok(a.evidence);
        if (prev) {
          // Keep the largest evidence estimate for per-turn occupancy.
          if (tk > prev.tk) prev.tk = tk;
          continue;
        }
        preMap.set(key, {
          k,
          n: a.name,
          tk,
          used: observable ? invokedNames.has(key) : true,
          est: true,
          ...(observable ? {} : { observable: false }),
        });
      }
    }
    return [...preMap.values()];
  };
  const rootPre = buildPre(main);

  // ----- nodes -----
  const rootSelf = obsSelf(main);
  const rootModel = (() => {
    let best = "";
    let bestN = 0;
    for (const [m, n] of Object.entries(agg.models)) if (n > bestN) { best = m; bestN = n; }
    return best || undefined;
  })();
  const root: ObsNode = {
    id: agg.sessionId,
    type: "session",
    name: "main",
    label: agg.project + (agg.cwd ? ` — ${agg.cwd}` : ""),
    ...(rootModel ? { model: rootModel } : {}),
    parentId: null,
    start: agg.firstTs,
    ...(rootSelf.dur !== undefined ? { dur: rootSelf.dur } : {}),
    selfTok: rootSelf.selfTok,
    cost: rootSelf.cost,
    ctx: rootSelf.ctx,
    turns: rootSelf.turns,
    tools: rootSelf.tools,
    pre: rootPre,
    dyn: obsDyn(main, "main", resultFor),
    ctxBreakdown: obsBreakdown(main, resultFor),
    toolTokens: obsToolTokens(main, resultFor),
  };
  const nodes: ObsNode[] = [root];

  // Agent tool_uses on the main chain claim sidechain chains → child nodes,
  // plus a display-only dyn event on the root (spec §3: never sum both).
  let ai = 0;
  const addAgentNode = (name: string, chain: SidechainChain, at: string) => {
    const self = obsSelf(chain.lines);
    const model = chainModel(chain);
    // Stable-ish id: prefer the on-disk agent id (dedicated transcripts).
    const id = chain.agentId ? `${agg.sessionId}:${chain.agentId}` : `${agg.sessionId}:a${ai++}`;
    nodes.push({
      id,
      type: "agent",
      name,
      label: clip(chain.promptText, LABEL_LEN),
      ...(model ? { model } : {}),
      src: chain.source, // "file" = dedicated subagents/*.jsonl (task #11)
      parentId: agg.sessionId,
      start: chain.rootTs,
      ...(self.dur !== undefined ? { dur: self.dur } : {}),
      selfTok: self.selfTok,
      cost: self.cost,
      ctx: self.ctx,
      turns: self.turns,
      tools: self.tools,
      // task #11: the agent's own boot context, from its dedicated transcript
      // (legacy inline chains rarely carry reminders — usually empty there).
      pre: buildPre(chain.lines),
      dyn: obsDyn(chain.lines, name, resultFor),
      ctxBreakdown: obsBreakdown(chain.lines, resultFor),
      toolTokens: obsToolTokens(chain.lines, resultFor),
    });
    root.dyn.push({ k: "agent", n: name, tk: self.selfTok, at, by: "main" });
  };

  for (const ln of main) {
    if (ln.kind !== "assistant") continue;
    for (const tu of ln.toolUses) {
      const { kind, name } = toolNodeKind(tu);
      if (kind !== "agent") continue;
      const chain = claimChain(chains, promptOf(tu.input), ln.ts, tu.id || undefined);
      if (chain) addAgentNode(name, chain, ln.ts);
    }
  }
  for (const c of chains) {
    if (!c.claimed)
      addAgentNode(
        (c.agentId && subagentMeta.get(c.agentId)?.agentType) || "(sidechain)",
        c,
        c.rootTs,
      );
  }
  root.dyn.sort((a, b) => a.at.localeCompare(b.at));

  // ----- waste (spec §4.5) — observable kinds only -----
  const observablePre = rootPre.filter((r) => r.observable !== false);
  const preTotal = rootPre.reduce((s, r) => s + r.tk, 0);
  const waste = observablePre.reduce((s, r) => s + (r.used ? 0 : r.tk), 0);
  const obsTotal = observablePre.reduce((s, r) => s + r.tk, 0);

  const json = JSON.stringify({
    v: 3,
    cap: OBS_CAP,
    generatedAt: new Date().toISOString(),
    session: {
      sessionId: agg.sessionId,
      project: agg.project,
      ...(agg.cwd ? { cwd: agg.cwd } : {}),
      firstTs: agg.firstTs,
      lastTs: agg.lastTs,
      prompts: agg.prompts,
    },
    nodes,
    waste: {
      preTotal,
      observableTotal: obsTotal,
      wasted: waste,
      wastePct: obsTotal > 0 ? waste / obsTotal : 0,
      // §7.4: per-turn cost of waste — needs cache pricing decision first.
      turnCount: root.turns,
    },
  });
  observeCache.set(sessionId, { at: Date.now(), json });
  return json;
}

// ----------------------------------------------------------------------------
// v4: global usage statistics (/api/stats) — self-contained on-disk scan.
// In-memory state only covers SEED_MTIME_WINDOW_MS (~48h), so this endpoint
// re-reads transcripts from disk for the requested window (1..30 days).
// Detection mirrors parseLine (Skill / Task|Agent / detectCommand) on purpose —
// patterns are COPIED, not refactored, to keep the live ingest path untouched.
// ----------------------------------------------------------------------------
const STATS_CACHE_MS = 60_000;
const STATS_DAY_MS = 86_400_000;
// keyed by `days`; valid while <60s old AND the file signature is unchanged.
const statsCache = new Map<number, { at: number; sig: string; json: string }>();

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface StatEntity {
  count: number;
  sessions: Set<string>;
  tokens: number;
  lastMs: number;
  byDay: number[];
}

function buildStatsJSON(days: number): string {
  const t0 = Date.now();

  // ----- window: `days` local calendar days, oldest→newest, incl. today -----
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startMs = today.getTime() - (days - 1) * STATS_DAY_MS;
  const dayKeys: string[] = [];
  const dayIdx = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    // +12h before localDayKey sidesteps DST-shortened days.
    const k = localDayKey(startMs + i * STATS_DAY_MS + STATS_DAY_MS / 2);
    dayIdx.set(k, i);
    dayKeys.push(k);
  }

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
  const hit = statsCache.get(days);
  if (hit && hit.sig === sig && t0 - hit.at < STATS_CACHE_MS) return hit.json;

  // ----- aggregation state -----
  const sessionsSeen = new Set<string>();
  const projectsSeen = new Set<string>();
  const daySessions: Array<Set<string>> = dayKeys.map(() => new Set());
  const dayPrompts: number[] = new Array(days).fill(0);
  const dayTokens: number[] = new Array(days).fill(0);
  let prompts = 0;
  let tokens = 0;
  let cost = 0;
  const skills = new Map<string, StatEntity>();
  const commands = new Map<string, StatEntity>();
  const rules = new Map<string, StatEntity>();
  const agents = new Map<string, StatEntity>();
  // v5: tools = built-in tool_use names (mcp__* excluded; Skill/Task/Agent have
  // their own categories); mcp = mcp__<server>__<tool> grouped by server;
  // plugins = derived from "<plugin>:" prefix on skill/command/agent names.
  const tools = new Map<string, StatEntity>();
  const mcp = new Map<string, StatEntity>();
  const plugins = new Map<string, StatEntity>();
  const models = new Map<string, { count: number; tokens: number }>();
  // Task tool_use id → agent entity, to attribute sub-agent transcript tokens
  // (join via subagents/agent-<id>.meta.json toolUseId, same link as task #11).
  const taskAgent = new Map<string, StatEntity>();
  const pendingSub: Array<{ toolUseId: string; tokens: number }> = [];

  // "<plugin>:<rest>" (skills/agents) or "/<plugin>:<rest>" (commands) → plugin name.
  const pluginOf = (name: string): string | null => {
    const n = name.startsWith("/") ? name.slice(1) : name;
    const i = n.indexOf(":");
    return i > 0 ? n.slice(0, i) : null;
  };

  const bump = (m: Map<string, StatEntity>, name: string, sid: string, tsMs: number): StatEntity => {
    let e = m.get(name);
    if (!e) {
      e = { count: 0, sessions: new Set(), tokens: 0, lastMs: 0, byDay: new Array(days).fill(0) };
      m.set(name, e);
    }
    e.count++;
    e.sessions.add(sid);
    if (tsMs > e.lastMs) e.lastMs = tsMs;
    const di = dayIdx.get(localDayKey(tsMs));
    if (di !== undefined) e.byDay[di]++;
    return e;
  };

  // ----- scan -----
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
    let fileTok = 0; // sub-agent transcript in-window token sum (for agent join)
    let contributed = false;
    let projectAdded = false;

    for (let s = 0, e = 0; s < raw.length; s = e + 1) {
      e = raw.indexOf("\n", s);
      if (e === -1) e = raw.length;
      const line = raw.slice(s, e);
      if (!line) continue;
      // Cheap substring pre-filters before JSON.parse (files can be huge).
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
      const tsMs = Date.parse(typeof o.timestamp === "string" ? o.timestamp : "");
      if (!Number.isFinite(tsMs) || tsMs < startMs) continue; // outside window
      const di = dayIdx.get(localDayKey(tsMs));
      const sid = sub?.parentSessionId ?? (typeof o.sessionId === "string" ? o.sessionId : fallbackSid);
      const msg = o.message;

      contributed = true;
      sessionsSeen.add(sid);
      if (di !== undefined) daySessions[di].add(sid);
      if (!projectAdded) {
        projectsSeen.add(projectName(o.cwd, slug));
        projectAdded = true;
      }

      if (isAsst) {
        const u = usageFrom(msg?.usage);
        if (u) {
          const tok = u.input + u.output + u.cacheRead + u.cacheWrite;
          tokens += tok;
          fileTok += tok;
          if (di !== undefined) dayTokens[di] += tok;
          const model = typeof msg?.model === "string" ? msg.model : "unknown";
          if (model !== "<synthetic>") {
            cost += costUSD(model, u);
            const me = models.get(model) ?? { count: 0, tokens: 0 };
            me.count++;
            me.tokens += tok;
            models.set(model, me);
          }
        }
        if (Array.isArray(msg?.content)) {
          for (const b of msg.content) {
            if (!b || typeof b !== "object" || b.type !== "tool_use" || typeof b.name !== "string") continue;
            if (b.name === "Skill" && b.input && typeof b.input === "object") {
              // Real format: input.skill (verified). Keep command/name fallbacks.
              const sn = b.input.skill ?? b.input.command ?? b.input.name;
              if (typeof sn === "string") {
                bump(skills, sn, sid, tsMs);
                const pl = pluginOf(sn);
                if (pl) bump(plugins, pl, sid, tsMs);
              }
            } else if ((b.name === "Task" || b.name === "Agent") && b.input && typeof b.input === "object") {
              const at = b.input.subagent_type ?? b.input.subagentType ?? b.input.agent;
              if (typeof at === "string") {
                const ent = bump(agents, at, sid, tsMs);
                if (typeof b.id === "string" && b.id) taskAgent.set(b.id, ent);
                const pl = pluginOf(at);
                if (pl) bump(plugins, pl, sid, tsMs);
              }
            } else if (b.name.startsWith("mcp__")) {
              // mcp__<server>__<tool> → group by server (same as SessionDetail.mcp).
              const server = b.name.split("__")[1] || b.name;
              bump(mcp, server, sid, tsMs);
            } else {
              bump(tools, b.name, sid, tsMs);
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
      prompts++;
      if (di !== undefined) dayPrompts[di]++;
      const command = detectCommand(ptext);
      if (command) {
        bump(commands, command, sid, tsMs);
        const pl = pluginOf(command);
        if (pl) bump(plugins, pl, sid, tsMs);
      }
      for (const r of detectRules(ptext)) bump(rules, r, sid, tsMs);
    }

    // Sub-agent transcript: link its token sum to the parent Task tool_use.
    if (sub && fileTok > 0) {
      try {
        const mo = JSON.parse(readFileSync(f.path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
        if (mo && typeof mo.toolUseId === "string") {
          pendingSub.push({ toolUseId: mo.toolUseId, tokens: fileTok });
        }
      } catch {
        // meta missing — tokens stay in totals, unattributed to an agent (fine)
      }
    }
    if (!contributed) continue;
  }

  // ----- join sub-agent tokens onto agent entities -----
  for (const p of pendingSub) {
    const ent = taskAgent.get(p.toolUseId);
    if (ent) ent.tokens += p.tokens;
  }

  // ----- shape response (contract: EXACT keys, count desc / tokens desc) -----
  const entOut = (m: Map<string, StatEntity>) =>
    Array.from(m.entries())
      .map(([name, e]) => ({
        name,
        count: e.count,
        sessions: e.sessions.size,
        tokens: e.tokens,
        lastUsed: new Date(e.lastMs).toISOString(),
        byDay: e.byDay,
      }))
      .sort((a, b) => b.count - a.count);

  const skillsOut = entOut(skills);
  const commandsOut = entOut(commands);
  const rulesOut = entOut(rules);
  const agentsOut = entOut(agents);
  const toolsOut = entOut(tools);
  const mcpOut = entOut(mcp);
  const pluginsOut = entOut(plugins);
  const sum = (arr: Array<{ count: number }>) => arr.reduce((a, x) => a + x.count, 0);

  const json = JSON.stringify({
    days,
    generatedAt: new Date().toISOString(),
    totals: {
      sessions: sessionsSeen.size,
      projects: projectsSeen.size,
      prompts,
      tokens,
      cost,
      agentRuns: sum(agentsOut),
      skillInvocations: sum(skillsOut),
      commandRuns: sum(commandsOut),
      ruleLoads: sum(rulesOut),
      toolRuns: sum(toolsOut),
      mcpCalls: sum(mcpOut),
      pluginUses: sum(pluginsOut),
    },
    byDay: dayKeys.map((date, i) => ({
      date,
      sessions: daySessions[i].size,
      prompts: dayPrompts[i],
      tokens: dayTokens[i],
    })),
    skills: skillsOut,
    commands: commandsOut,
    rules: rulesOut,
    agents: agentsOut,
    tools: toolsOut,
    mcp: mcpOut,
    plugins: pluginsOut,
    models: Array.from(models.entries())
      .map(([name, m]) => ({ name, count: m.count, tokens: m.tokens }))
      .sort((a, b) => b.tokens - a.tokens),
  });
  statsCache.set(days, { at: Date.now(), sig, json });
  log(`stats(${days}d): ${files.length} files (${(totalB / 1e6).toFixed(1)}MB) in ${Date.now() - t0}ms`);
  return json;
}

// ----------------------------------------------------------------------------
// HTTP + SSE server
// ----------------------------------------------------------------------------
function snapshotJSON(): string {
  return JSON.stringify({
    events: ring,
    sessions: Array.from(sessions.values()),
    startedAt,
  });
}

function sseFormat(ev: MonitorEvent): string {
  return `id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`;
}

function serveStatic(file: string, contentType: string): Response {
  const path = join(PUBLIC_DIR, file);
  try {
    if (existsSync(path)) {
      // UI assets are small (<40 KB); read into memory rather than depend on a
      // runtime-specific file-stream helper. Works identically on Bun and Node.
      const bytes = readFileSync(path);
      return new Response(bytes, { headers: { "Content-Type": contentType } });
    }
  } catch (e) {
    log("static serve error", path, e);
  }
  // Graceful placeholder so integration order doesn't matter.
  return new Response(
    `UI not built yet — ${file} missing. The collector API is live at /api/snapshot and /events.`,
    { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

// Runtime-agnostic server: use Bun.serve when running under Bun, otherwise adapt
// the same Fetch-style handler onto node:http so `npx` (Node) works unchanged.
type FetchHandler = (req: Request) => Promise<Response> | Response;
function startServer(opts: {
  hostname: string;
  port: number;
  fetch: FetchHandler;
  error?: (e: unknown) => Response;
}): { port: number } {
  const bun = (globalThis as { Bun?: { serve: (o: unknown) => { port: number } } }).Bun;
  if (bun) {
    return bun.serve(opts);
  }
  const nodeServer = createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
        else if (v != null) headers.set(k, v);
      }
      // All routes are GET; the request body is never read, so we omit it.
      const request = new Request(`http://${opts.hostname}:${opts.port}${req.url}`, {
        method: req.method ?? "GET",
        headers,
      });
      const response = await opts.fetch(request);
      res.statusCode = response.status;
      response.headers.forEach((val, key) => res.setHeader(key, val));
      if (response.body) {
        const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
        // Cancel the underlying Web stream (e.g. an SSE feed) when the client leaves.
        res.on("close", () => stream.destroy());
        stream.pipe(res);
      } else {
        res.end(Buffer.from(await response.arrayBuffer()));
      }
    } catch (e) {
      log("server error", e);
      try {
        const r = opts.error?.(e);
        if (r) {
          res.statusCode = r.status;
          res.end(await r.text());
        } else {
          res.statusCode = 500;
          res.end("Internal error");
        }
      } catch {
        res.statusCode = 500;
        res.end("Internal error");
      }
    }
  });
  nodeServer.listen(opts.port, opts.hostname);
  return { port: opts.port };
}

const server = startServer({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" ) {
      return serveStatic("index.html", "text/html; charset=utf-8");
    }
    if (path === "/app.js") {
      return serveStatic("app.js", "text/javascript; charset=utf-8");
    }
    if (path === "/observe" || path === "/observe.html") {
      return serveStatic("observe.html", "text/html; charset=utf-8");
    }
    if (path === "/observe.js") {
      return serveStatic("observe.js", "text/javascript; charset=utf-8");
    }
    if (path === "/stats" || path === "/stats.html") {
      return serveStatic("stats.html", "text/html; charset=utf-8");
    }
    if (path === "/stats.js") {
      return serveStatic("stats.js", "text/javascript; charset=utf-8");
    }
    if (path === "/projects" || path === "/projects.html") {
      return serveStatic("projects.html", "text/html; charset=utf-8");
    }
    if (path === "/projects.js") {
      return serveStatic("projects.js", "text/javascript; charset=utf-8");
    }
    if (path.startsWith("/vendor/")) {
      // Vendored ESM modules (preact/htm). Name-only — no traversal.
      const f = path.slice("/vendor/".length);
      if (/^[\w.-]+\.js$/.test(f)) {
        return serveStatic(join("vendor", f), "text/javascript; charset=utf-8");
      }
    }
    if (path === "/api/snapshot") {
      return new Response(snapshotJSON(), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (path === "/api/projects") {
      // Parameterless (R-1.15): fold the in-memory sessions map into project
      // records. Pure in-memory read, no disk access (R-1.9). Envelope
      // {projects, startedAt} with startedAt mirroring /api/snapshot (R-1.12).
      const json = JSON.stringify(foldProjects(sessions.values(), startedAt));
      return new Response(json, {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (path === "/api/stats") {
      // v4: ?days=N clamped to 1..30, default 14.
      const dq = url.searchParams.get("days");
      const n = dq === null ? 14 : Math.floor(Number(dq));
      const days = Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : 14;
      return new Response(buildStatsJSON(days), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (path.startsWith("/api/session/")) {
      const id = decodeURIComponent(path.slice("/api/session/".length));
      const json = id ? buildSessionDetail(id) : null;
      if (json === null) {
        return new Response(JSON.stringify({ error: "unknown session" }), {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      return new Response(json, {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (path.startsWith("/api/observe/")) {
      const id = decodeURIComponent(path.slice("/api/observe/".length));
      const json = id ? buildObserveSnapshot(id) : null;
      if (json === null) {
        return new Response(JSON.stringify({ error: "unknown session" }), {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      return new Response(json, {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (path === "/events") {
      const lastIdHeader = req.headers.get("Last-Event-ID");
      const lastId = lastIdHeader ? parseInt(lastIdHeader, 10) : NaN;

      let sendFn: (ev: MonitorEvent) => void;
      let keepalive: ReturnType<typeof setInterval>;

      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const push = (s: string) => {
            try {
              controller.enqueue(enc.encode(s));
            } catch {
              // controller closed
            }
          };

          // Backfill: replay buffered events with id > Last-Event-ID.
          if (Number.isFinite(lastId)) {
            for (const ev of ring) {
              if (ev.id > lastId) push(sseFormat(ev));
            }
          }

          sendFn = (ev: MonitorEvent) => push(sseFormat(ev));
          clients.add(sendFn);

          push(`: connected\n\n`);
          keepalive = setInterval(() => push(`: keepalive\n\n`), KEEPALIVE_MS);
        },
        cancel() {
          clients.delete(sendFn);
          clearInterval(keepalive);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
  error(e) {
    log("server error", e);
    return new Response("Internal error", { status: 500 });
  },
});

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
try {
  firstScan();
} catch (e) {
  log("firstScan failed", e);
}
startWatch();
setInterval(rescan, RESCAN_INTERVAL_MS);

log(`listening on http://${HOST}:${server.port}  (watching ${PROJECTS_DIR})`);
