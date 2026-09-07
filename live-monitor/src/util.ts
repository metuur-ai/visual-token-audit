// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------



import { basename } from "path";
import { EVIDENCE_LEN, TEXT_SNIPPET_LEN } from "./config.ts";
import { Usage } from "./types.ts";

export function log(...args: unknown[]) {
  console.error("[collector]", ...args);
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Decode a project name. Prefer basename of `cwd` when present; otherwise decode
// the dir slug. Slugs look like "-Users-javierbenavides-others-foo-bar" — the
// leading "-" and path separators became "-", so take the last segment.
export function decodeProjectFromSlug(slug: string): string {
  // Strip a single leading dash, split on dashes, take last non-empty segment.
  const parts = slug.replace(/^-+/, "").split("-").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : slug;
}

export function projectName(cwd: unknown, slug: string): string {
  if (typeof cwd === "string" && cwd.length) {
    const b = basename(cwd);
    if (b) return b;
  }
  return decodeProjectFromSlug(slug);
}

export function snippet(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, TEXT_SNIPPET_LEN);
}

export function clip(s: string, n: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

export function usageFrom(u: any): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  return {
    ...(u.reasoning_output_tokens !== undefined ? { reasoning: num(u.reasoning_output_tokens) } : {}),
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
export function addUsage(dst: Usage, src?: Usage) {
  if (!src) return;
  dst.input += src.input;
  dst.output += src.output;
  dst.cacheRead += src.cacheRead;
  dst.cacheWrite += src.cacheWrite;
  if (src.reasoning !== undefined) dst.reasoning = (dst.reasoning ?? 0) + src.reasoning;
}
export function scaleUsage(u: Usage | undefined, f: number): Usage | undefined {
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
export function detectCommand(text: string): string | undefined {
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
export function detectRules(text: string): string[] {
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

// Detect skills invoked through a loader convention rather than the `Skill` tool.
// Plugin commands (e.g. uncle-dev) resolve their skill via a Bash loader that
// prints marker lines into the tool_result output:
//   SKILL: agent-skills:uncle-dev-research
//   COMPANION: agent-skills:<other>
// The marker is the authoritative "this skill fired" signal (companion-inclusive),
// independent of whether the body ever materializes as a discrete context blob.
// A leading loader namespace (before ':') is stripped so names key consistently.
export function detectSkillLoads(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /^\s*(?:SKILL|COMPANION):\s*([\w.:/-]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < 16) {
    const raw = m[1];
    const name = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// Collect auto-loading evidence strings from a user prompt: <system-reminder>
// first lines and hook markers. Returns short evidence snippets.
export function detectReminders(text: string): string[] {
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

