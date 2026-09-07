export interface CodexResource {
  kind: "system" | "skill" | "memory";
  name: string;
  tokens: number;
  path?: string;
}

// Evidence comes from the actual rollout, rather than today's installed files.
export function codexResources(text: string, label: string): CodexResource[] {
  const out: CodexResource[] = [];
  let remaining = text;
  for (const match of text.matchAll(/^- ([^\n]+?): ([^\n]+?) \(file: ([^)]+)\)\s*$/gm)) {
    if (!match[3].endsWith("SKILL.md")) continue;
    out.push({ kind: "skill", name: match[1], path: match[3], tokens: estimate(match[0]) });
    remaining = remaining.replace(match[0], "");
  }
  if (remaining.trim()) out.push({
    kind: /^# AGENTS\.md|^<INSTRUCTIONS>/.test(text.trim()) ? "memory" : "system",
    name: /^# AGENTS\.md/.test(text.trim()) ? "AGENTS.md instructions" : label,
    tokens: estimate(remaining),
  });
  return out;
}

export function nestedToolRequests(input: unknown): string[] {
  const source = typeof input === "string" ? input : JSON.stringify(input ?? "");
  // These are syntactic requests in the wrapper, not proof that a branch ran.
  return [...source.matchAll(/\btools\.([A-Za-z_][\w]*)\s*\(/g)].map(m => m[1]);
}

const estimate = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);
