// ----------------------------------------------------------------------------
// Startup inventory — cached disk scan of what Claude Code eager-loads at boot,
// so the observe Loading panel can reconstruct the `base` floor (skills/agents/
// memory) that the transcript can't itemize. DESCRIPTIONS ONLY for skills/agents
// (bodies load on invoke → already counted as dyn elsewhere); memory loads whole.
//
// Session-independent + module-cached (60s TTL): the scan touches hundreds of
// files and tokenizes once. Robust: missing dirs/files skip silently; never
// throws out of getStartupInventory.
// ----------------------------------------------------------------------------



import { readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { countTokens, tokenizerProvenance } from "./tokenizer.ts";
import { log } from "./util.ts";

export interface InvItem { name: string; tk: number; } // qualified name
export interface MemItem { path: string; tk: number; }
export interface StartupInventory {
  skills: InvItem[];
  agents: InvItem[];
  memory: MemItem[];
  scannedAt: string;
  tokenizer: "o200k" | "est";
}

const TTL_MS = 60_000;
let cache: { inv: StartupInventory; cwd: string; at: number } | null = null;

// ----- fs helpers (never throw) ---------------------------------------------
function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
function safeFiles(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(ext))
      .map((d) => d.name);
  } catch {
    return [];
  }
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Minimal YAML front-matter parse: only `name:` and `description:` from the
// first `---`/`---` fence. Descriptions can be long single lines.
function frontMatter(txt: string): { name?: string; description?: string } {
  if (!txt.startsWith("---")) return {};
  const end = txt.indexOf("\n---", 3);
  const block = end < 0 ? txt : txt.slice(0, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split("\n")) {
    const nm = line.match(/^name:\s*(.*)$/);
    if (nm && out.name === undefined) out.name = unquote(nm[1]);
    const dm = line.match(/^description:\s*(.*)$/);
    if (dm && out.description === undefined) out.description = unquote(dm[1]);
  }
  return out;
}
function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Token basis for a skill/agent listing line (approximates the injected line).
function descTk(qualified: string, description: string): number {
  return countTokens("- " + qualified + ": " + (description ?? ""));
}

// Read a SKILL.md, return {qualifiedName, tk} using `nsPrefix` for plugin
// scoping. Falls back to the dir name when front-matter `name` is absent.
function skillItem(mdPath: string, fallbackName: string, nsPrefix: string): InvItem | null {
  const txt = safeRead(mdPath);
  if (!txt) return null;
  const fm = frontMatter(txt);
  const base = fm.name || fallbackName;
  const name = nsPrefix ? nsPrefix + ":" + base : base;
  return { name, tk: descTk(name, fm.description ?? "") };
}

// ----- skills ----------------------------------------------------------------
function discoverSkills(cwd: string): InvItem[] {
  const seen = new Set<string>();
  const out: InvItem[] = [];
  const add = (it: InvItem | null) => {
    if (it && !seen.has(it.name)) {
      seen.add(it.name);
      out.push(it);
    }
  };
  // user: ~/.claude/skills/*/SKILL.md
  const userSkills = join(homedir(), ".claude", "skills");
  for (const d of safeDirs(userSkills)) add(skillItem(join(userSkills, d, "SKILL.md"), d, ""));
  // project: <cwd>/.claude/skills/**/SKILL.md (recurse)
  if (cwd) walkSkills(join(cwd, ".claude", "skills"), add, 0);
  // plugins: installed_plugins.json → each installPath/skills/*/SKILL.md
  for (const { ns, installPath } of enabledPlugins()) {
    const dir = join(installPath, "skills");
    for (const d of safeDirs(dir)) add(skillItem(join(dir, d, "SKILL.md"), d, ns));
  }
  return out;
}

// Recursively find SKILL.md under a project skills dir (bounded depth). Project
// skills are bare-named (no plugin namespace).
function walkSkills(dir: string, add: (it: InvItem | null) => void, depth: number): void {
  if (depth > 6 || !isDir(dir)) return;
  const skill = join(dir, "SKILL.md");
  if (isFile(skill)) add(skillItem(skill, basename(dir), ""));
  for (const d of safeDirs(dir)) walkSkills(join(dir, d), add, depth + 1);
}

// ----- agents -----------------------------------------------------------------
function discoverAgents(cwd: string): InvItem[] {
  const seen = new Set<string>();
  const out: InvItem[] = [];
  const add = (name: string, tk: number) => {
    if (!seen.has(name)) {
      seen.add(name);
      out.push({ name, tk });
    }
  };
  const agentItem = (mdPath: string, ns: string) => {
    const txt = safeRead(mdPath);
    if (!txt) return;
    const fm = frontMatter(txt);
    const base = fm.name || basename(mdPath, ".md");
    const name = ns ? ns + ":" + base : base;
    add(name, descTk(name, fm.description ?? ""));
  };
  // user: ~/.claude/agents/*.md
  const userAgents = join(homedir(), ".claude", "agents");
  for (const f of safeFiles(userAgents, ".md")) agentItem(join(userAgents, f), "");
  // project: <cwd>/.claude/agents/**/*.md (recurse)
  if (cwd) walkAgents(join(cwd, ".claude", "agents"), agentItem, 0);
  // plugins: installPath/agents/*.md
  for (const { ns, installPath } of enabledPlugins()) {
    const dir = join(installPath, "agents");
    for (const f of safeFiles(dir, ".md")) agentItem(join(dir, f), ns);
  }
  return out;
}
function walkAgents(dir: string, cb: (p: string, ns: string) => void, depth: number): void {
  if (depth > 6 || !isDir(dir)) return;
  for (const f of safeFiles(dir, ".md")) cb(join(dir, f), "");
  for (const d of safeDirs(dir)) walkAgents(join(dir, d), cb, depth + 1);
}

// ----- memory -----------------------------------------------------------------
function discoverMemory(cwd: string): MemItem[] {
  const seen = new Set<string>();
  const out: MemItem[] = [];
  const home = homedir();
  const add = (p: string) => {
    if (seen.has(p) || !isFile(p)) return;
    seen.add(p);
    const txt = safeRead(p);
    if (!txt) return;
    out.push({ path: p, tk: countTokens(txt) });
  };
  add(join(home, ".claude", "CLAUDE.md"));
  add(join(home, "CLAUDE.md"));
  // project CLAUDE.md chain: walk up from cwd to filesystem root (join/dirname
  // already collapse "..", so no realpath needed).
  if (cwd) {
    let dir = cwd;
    for (let i = 0; i < 64; i++) {
      add(join(dir, "CLAUDE.md"));
      const parent = dirname(dir);
      if (!parent || parent === dir) break;
      dir = parent;
    }
  }
  // ~/.claude/rules/*.md
  const rulesDir = join(home, ".claude", "rules");
  for (const f of safeFiles(rulesDir, ".md")) add(join(rulesDir, f));
  // auto-memory: <home>/.claude/projects/<slug>/memory/*.md (MEMORY.md + recalled)
  if (cwd) {
    const slug = cwd.split("/").join("-");
    const memDir = join(home, ".claude", "projects", slug, "memory");
    for (const f of safeFiles(memDir, ".md")) add(join(memDir, f));
  }
  return out;
}

// ----- enabled plugins (installed_plugins.json) -------------------------------
// Returns {ns, installPath} for each enabled plugin install. ns = the part
// before "@" in the plugin key (matches toolNodeKind colon naming). Uses the
// authoritative installPath — never globs plugins/cache directly.
function enabledPlugins(): Array<{ ns: string; installPath: string }> {
  const out: Array<{ ns: string; installPath: string }> = [];
  const txt = safeRead(join(homedir(), ".claude", "plugins", "installed_plugins.json"));
  if (!txt) return out;
  try {
    const j = JSON.parse(txt) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    for (const [key, recs] of Object.entries(j.plugins ?? {})) {
      const ns = key.includes("@") ? key.split("@")[0] : key;
      for (const r of recs) {
        if (r && typeof r.installPath === "string") out.push({ ns, installPath: r.installPath });
      }
    }
  } catch (e) {
    log("startup-inventory: installed_plugins.json parse failed", e);
  }
  return out;
}

// Module-cached (60s TTL); recompute on cwd change or expiry. Never throws.
export function getStartupInventory(cwd?: string): StartupInventory {
  const key = cwd ?? "";
  const now = Date.now();
  if (cache && cache.cwd === key && now - cache.at < TTL_MS) return cache.inv;
  let inv: StartupInventory;
  try {
    inv = {
      skills: discoverSkills(key),
      agents: discoverAgents(key),
      memory: discoverMemory(key),
      scannedAt: new Date().toISOString(),
      tokenizer: tokenizerProvenance(),
    };
  } catch (e) {
    log("startup-inventory: scan failed", e);
    inv = { skills: [], agents: [], memory: [], scannedAt: new Date().toISOString(), tokenizer: tokenizerProvenance() };
  }
  cache = { inv, cwd: key, at: now };
  return inv;
}
