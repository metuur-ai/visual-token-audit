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




import { join } from "path";
import { EVIDENCE_LEN, startedAt } from "./config.ts";
import { MonitorEvent, SessionLine, SubagentPath, ToolUseBlock } from "./types.ts";
import { clip, detectCommand, detectReminders, detectRules, projectName, snippet, usageFrom } from "./util.ts";

export interface ParseResult {
  ev: Omit<MonitorEvent, "id">;
  line: SessionLine;
}

export function parseLine(raw: string, slug: string, sub?: SubagentPath): ParseResult | null {
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
        { command, reminders, textBytes: Buffer.byteLength(joined, "utf8") },
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
        { command, reminders, textBytes: Buffer.byteLength(content, "utf8") },
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

