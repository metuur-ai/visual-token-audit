export interface CodexResource {
  kind: "system" | "skill" | "memory";
  name: string;
  tokens: number;
  path?: string;
  evidence: "advertised" | "recorded instructions";
}

// Evidence comes from the actual rollout, rather than today's installed files.
export function codexResources(text: string, label: string): CodexResource[] {
  const out: CodexResource[] = [];
  const roots = new Map([...text.matchAll(/^- `([^`]+)` = `([^`]+)`\s*$/gm)].map(m => [m[1], m[2]]));
  let remaining = text;
  for (const match of text.matchAll(/^- ([^\n]+?): ([^\n]+?) \(file: ([^)]+)\)\s*$/gm)) {
    if (!match[3].endsWith("SKILL.md")) continue;
    const [alias, ...parts] = match[3].split("/");
    const path = roots.has(alias) ? [roots.get(alias), ...parts].join("/") : match[3];
    out.push({ kind: "skill", name: match[1], path, tokens: estimate(match[0]), evidence: "advertised" });
    remaining = remaining.replace(match[0], "");
  }
  if (remaining.trim()) out.push({
    kind: /^# AGENTS\.md|^<INSTRUCTIONS>/.test(text.trim()) ? "memory" : "system",
    name: /^# AGENTS\.md/.test(text.trim()) ? "AGENTS.md instructions" : label,
    tokens: estimate(remaining),
    evidence: "recorded instructions",
  });
  return out;
}

export function nestedToolRequests(input: unknown): string[] {
  const source = typeof input === "string" ? input : JSON.stringify(input ?? "");
  // These are syntactic requests in the wrapper, not proof that a branch ran.
  return [...source.matchAll(/\btools\.([A-Za-z_][\w]*)\s*\(/g)].map(m => m[1]);
}

const estimate = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);

// Exec results can wrap text blocks around JSON-encoded shell results. Decode
// only the known result containers; never interpret the returned text as code.
export function codexOutputText(output: unknown, depth = 0): string {
  if (depth > 10) return "";
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      if (parsed && (typeof parsed === "object" || typeof parsed === "string")) return codexOutputText(parsed, depth + 1);
    } catch { /* Plain tool output. */ }
    return output;
  }
  if (Array.isArray(output)) return output.map(item => codexOutputText(item, depth + 1)).join("\n");
  if (output && typeof output === "object") {
    const result = output as Record<string, unknown>;
    for (const key of ["output", "text", "content", "value"])
      if (result[key] !== undefined) return codexOutputText(result[key], depth + 1);
    return JSON.stringify(output);
  }
  return output == null ? "" : String(output);
}

export function codexSkillDocuments(text: string): string[] {
  const names = new Set<string>();
  for (const block of text.matchAll(/(?:^|\n)---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/g)) {
    const name = block[1].match(/^name:\s*["']?([\w:.-]+)["']?\s*$/m)?.[1];
    if (name) names.add(name);
  }
  return [...names];
}
