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

// `chars`/`rawChars` are the skill-listing entry size after/before the
// per-entry description clamp — the unit Claude Code budgets in. Skills only.
export interface InvItem { name: string; tk: number; chars?: number; rawChars?: number } // qualified name
export interface MemItem { path: string; tk: number; }
// A .claude/rules/*.md file. `paths` present → conditional: Claude Code scopes
// it to files matching those globs, so "was it live?" is a per-session question
// answered against the files the session actually touched.
export interface RuleItem { name: string; tk: number; paths?: string[] }
export interface StartupInventory {
  skills: InvItem[];
  agents: InvItem[];
  memory: MemItem[];
  rules: RuleItem[];
  scannedAt: string;
  tokenizer: "o200k" | "est";
  skillListingConfig: SkillListingConfig;
  plugins: PluginCounts;
}

// How many installed plugins actually contributed skills/agents. `skipped` > 0
// means the enablement filter dropped something; installed === enabled means the
// filter ran and found nothing to drop (as opposed to not running at all).
export interface PluginCounts {
  installed: number;
  enabled: number;
  skipped: number;
  // One entry per enabled bundle (deduped by ns; a bundle may have several
  // install records). `hooks` are the script basenames the bundle registers in
  // its hooks/hooks.json, which is how a transcript-observed hook name maps back
  // to its owning bundle — the expanded path is not observable in the transcript.
  bundles: PluginBundle[];
}
export interface PluginBundle { ns: string; hooks: string[] }
interface PluginScan extends PluginCounts {
  list: Array<{ ns: string; installPath: string }>;
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
// Also reads a `paths:` block sequence (rule scoping globs):
//   paths:
//     - "packages/api/src/**/*.ts"
function frontMatter(txt: string): { name?: string; description?: string; paths?: string[] } {
  if (!txt.startsWith("---")) return {};
  const end = txt.indexOf("\n---", 3);
  const block = end < 0 ? txt : txt.slice(0, end);
  const out: { name?: string; description?: string; paths?: string[] } = {};
  let inPaths = false;
  for (const line of block.split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (inPaths && item) {
      (out.paths ??= []).push(unquote(item[1]));
      continue;
    }
    if (!/^\s/.test(line)) inPaths = false; // any top-level key ends the sequence
    const nm = line.match(/^name:\s*(.*)$/);
    if (nm && out.name === undefined) out.name = unquote(nm[1]);
    const dm = line.match(/^description:\s*(.*)$/);
    if (dm && out.description === undefined) out.description = unquote(dm[1]);
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      out.paths ??= [];
    }
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

// ----- skill listing budget --------------------------------------------------
// Claude Code caps the *skill listing* (the "- name: description" block) by
// CHARACTERS, not tokens:
//
//   budgetChars = SLASH_COMMAND_TOOL_CHAR_BUDGET            (env, absolute)
//              ?? floor(contextWindow * BYTES_PER_TOKEN * skillListingBudgetFraction)
//
// With the defaults that is contextWindow * 0.04 → 8,000 chars at a 200k window
// and 40,000 at 1M. Each entry's description is independently clamped to
// skillListingMaxDescChars first. Over budget, Claude Code does NOT drop skills:
// it keeps the highest-priority descriptions and degrades the rest to name-only
// ("- name"), so the skill stays invocable but loses its "when to use" hint.
export const SKILL_DESC_CAP_DEFAULT = 1536;
export const SKILL_BUDGET_FRACTION_DEFAULT = 0.01;
export const SKILL_BYTES_PER_TOKEN = 4;
export const SKILL_CTX_DEFAULT = 200_000;

export interface SkillListingConfig {
  fraction: number;
  maxDescChars: number;
  bytesPerToken: number;
  envBudgetChars: number | null; // SLASH_COMMAND_TOOL_CHAR_BUDGET, if set
}
export interface SkillBudget {
  chars: number; // listing size after the per-entry cap
  rawChars: number; // before the per-entry cap
  budgetChars: number;
  contextWindow: number;
  fits: boolean;
  overBy: number; // chars over budget (0 when fits)
  utilPct: number; // chars / budgetChars * 100
  cappedEntries: number; // descriptions clamped by maxDescChars
  config: SkillListingConfig;
}

// The listing entry text Claude Code builds, with the description clamped.
function listingEntryChars(name: string, description: string, maxDescChars: number): number {
  const shown = Math.min((description ?? "").length, maxDescChars);
  return name.length + 4 + shown; // "- " + name + ": " + desc
}

function skillListingConfig(cwd: string): SkillListingConfig {
  const st = readSettings(cwd);
  const env = Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET);
  return {
    fraction: st.skillListingBudgetFraction ?? SKILL_BUDGET_FRACTION_DEFAULT,
    maxDescChars: st.skillListingMaxDescChars ?? SKILL_DESC_CAP_DEFAULT,
    bytesPerToken: SKILL_BYTES_PER_TOKEN,
    envBudgetChars: Number.isFinite(env) && env > 0 ? env : null,
  };
}

// Per-session verdict: the budget depends on the session's context window, so
// this is computed at the call site (where the model is known), not cached in
// the cwd-keyed inventory.
export function skillListingBudget(inv: StartupInventory, contextWindow: number): SkillBudget {
  const cfg = inv.skillListingConfig;
  const n = inv.skills.length;
  const chars = inv.skills.reduce((s, x) => s + (x.chars ?? 0), 0) + Math.max(0, n - 1);
  const rawChars = inv.skills.reduce((s, x) => s + (x.rawChars ?? x.chars ?? 0), 0) + Math.max(0, n - 1);
  const budgetChars =
    cfg.envBudgetChars ??
    Math.max(1, Math.floor(contextWindow * cfg.bytesPerToken * cfg.fraction));
  return {
    chars,
    rawChars,
    budgetChars,
    contextWindow,
    fits: chars <= budgetChars,
    overBy: Math.max(0, chars - budgetChars),
    utilPct: budgetChars > 0 ? (chars / budgetChars) * 100 : 0,
    cappedEntries: inv.skills.filter((x) => (x.rawChars ?? 0) > cfg.maxDescChars).length,
    config: cfg,
  };
}

// Known window sizes, ascending. Anything larger than the last tier is used as-is.
export const CONTEXT_WINDOW_TIERS = [SKILL_CTX_DEFAULT, 1_000_000];

// Sessions on a 1M-context model get a 5x larger listing budget, which can flip
// the verdict. Model ids carry an explicit "[1m]" marker for the long window.
//
// Transcripts frequently record the plain id ("claude-opus-5") even when the
// session ran the long window, so the marker alone under-reports. A measured
// peak occupancy larger than the nominal window is proof of a bigger window —
// the API cannot accept a prompt that does not fit — so promote to the smallest
// tier that holds what was actually observed. Without this, a 1M session reads
// as "274.2k / 200k (137%)" and every derived percentage is wrong.
export function contextWindowForModel(model: string | undefined, measuredPeak = 0): number {
  const nominal = model && model.includes("[1m]") ? 1_000_000 : SKILL_CTX_DEFAULT;
  if (measuredPeak <= nominal) return nominal;
  return CONTEXT_WINDOW_TIERS.find((t) => t >= measuredPeak) ?? measuredPeak;
}

// Read a SKILL.md, return {qualifiedName, tk} using `nsPrefix` for plugin
// scoping. Falls back to the dir name when front-matter `name` is absent.
function skillItem(
  mdPath: string,
  fallbackName: string,
  nsPrefix: string,
  maxDescChars: number,
): InvItem | null {
  const txt = safeRead(mdPath);
  if (!txt) return null;
  const fm = frontMatter(txt);
  const base = fm.name || fallbackName;
  const name = nsPrefix ? nsPrefix + ":" + base : base;
  const desc = fm.description ?? "";
  return {
    name,
    tk: descTk(name, desc),
    chars: listingEntryChars(name, desc, maxDescChars),
    rawChars: listingEntryChars(name, desc, Infinity),
  };
}

// ----- skills ----------------------------------------------------------------
function discoverSkills(cwd: string, maxDescChars: number, plugins: PluginScan): InvItem[] {
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
  for (const d of safeDirs(userSkills)) {
    add(skillItem(join(userSkills, d, "SKILL.md"), d, "", maxDescChars));
  }
  // project: <cwd>/.claude/skills/**/SKILL.md (recurse)
  if (cwd) walkSkills(join(cwd, ".claude", "skills"), add, 0, maxDescChars);
  // plugins: installed_plugins.json → each installPath/skills/*/SKILL.md
  for (const { ns, installPath } of plugins.list) {
    const dir = join(installPath, "skills");
    for (const d of safeDirs(dir)) add(skillItem(join(dir, d, "SKILL.md"), d, ns, maxDescChars));
  }
  return out;
}

// Recursively find SKILL.md under a project skills dir (bounded depth). Project
// skills are bare-named (no plugin namespace).
function walkSkills(
  dir: string,
  add: (it: InvItem | null) => void,
  depth: number,
  maxDescChars: number,
): void {
  if (depth > 6 || !isDir(dir)) return;
  const skill = join(dir, "SKILL.md");
  if (isFile(skill)) add(skillItem(skill, basename(dir), "", maxDescChars));
  for (const d of safeDirs(dir)) walkSkills(join(dir, d), add, depth + 1, maxDescChars);
}

// ----- agents -----------------------------------------------------------------
function discoverAgents(cwd: string, plugins: PluginScan): InvItem[] {
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
  for (const { ns, installPath } of plugins.list) {
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
  // NOTE: .claude/rules/*.md used to be folded in here. They are their own
  // category now (discoverRules) — counting them in both would double-count the
  // base floor.
  // auto-memory: <home>/.claude/projects/<slug>/memory/*.md (MEMORY.md + recalled)
  if (cwd) {
    const slug = cwd.split("/").join("-");
    const memDir = join(home, ".claude", "projects", slug, "memory");
    for (const f of safeFiles(memDir, ".md")) add(join(memDir, f));
  }
  return out;
}

// ----- rules ------------------------------------------------------------------
// <cwd>/.claude/rules/**/*.md (project) then ~/.claude/rules/**/*.md (user).
// Recursive: rules are commonly foldered by area (api/, ui/, shared/). The name
// is the path relative to its rules dir ("api/errors.md") — exactly the shape
// detectRules() captures from transcript evidence, so the two join cleanly.
// Project scope shadows user scope on an identical relative name.
function walkRules(dir: string, rel: string, add: (it: RuleItem) => void, depth: number): void {
  if (depth > 4) return;
  for (const f of safeFiles(dir, ".md")) {
    const txt = safeRead(join(dir, f));
    if (!txt) continue;
    const fm = frontMatter(txt);
    add({
      name: rel ? rel + "/" + f : f,
      tk: countTokens(txt), // whole body: a live rule is injected in full
      ...(fm.paths?.length ? { paths: fm.paths } : {}),
    });
  }
  for (const d of safeDirs(dir)) walkRules(join(dir, d), rel ? rel + "/" + d : d, add, depth + 1);
}
// Hook scripts a bundle actually registers, per its hooks/hooks.json manifest.
// Globbing hooks/ instead would count shared libraries (patterns.py, _base.py)
// that no event ever invokes. Commands are shell strings; the script is the
// `${CLAUDE_PLUGIN_ROOT}/<dir>/<file>` reference inside them. The directory is
// not always hooks/ (codex registers from scripts/), so match any depth and key
// off the script extension to avoid capturing directories or trailing args.
const HOOK_REF =
  /\$\{?CLAUDE_PLUGIN_ROOT\}?\/(?:[A-Za-z0-9._-]+\/)*([A-Za-z0-9._-]+\.(?:sh|mjs|cjs|js|py|ts))/g;
function declaredHooks(installPath: string): string[] {
  const out = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(join(installPath, "hooks", "hooks.json"), "utf8");
  } catch {
    return []; // no manifest → bundle registers no hooks
  }
  try {
    const cfg = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    for (const entries of Object.values(cfg.hooks ?? {})) {
      for (const m of JSON.stringify(entries).matchAll(HOOK_REF)) out.add(m[1]);
    }
  } catch (e) {
    log(`startup-inventory: ${installPath}/hooks/hooks.json parse failed`, e);
  }
  return [...out];
}
function discoverRules(cwd: string): RuleItem[] {
  const seen = new Set<string>();
  const out: RuleItem[] = [];
  const add = (it: RuleItem) => {
    if (seen.has(it.name)) return;
    seen.add(it.name);
    out.push(it);
  };
  if (cwd) walkRules(join(cwd, ".claude", "rules"), "", add, 0);
  walkRules(join(homedir(), ".claude", "rules"), "", add, 0);
  return out;
}

// ----- enabled plugins (installed_plugins.json ∩ settings.enabledPlugins) -----
// Returns {ns, installPath} for each enabled plugin install. ns = the part
// before "@" in the plugin key (matches toolNodeKind colon naming). Uses the
// authoritative installPath — never globs plugins/cache directly.
//
// Installed ≠ enabled. Plugin skills are listed only "where plugin is enabled",
// and enablement lives in settings.json's `enabledPlugins` map (keys are the
// same "plugin@marketplace" strings installed_plugins.json uses), NOT in the
// install record. Counting every install over-bills a disabled plugin's skills.
function enabledPlugins(cwd: string): PluginScan {
  const list: Array<{ ns: string; installPath: string }> = [];
  const txt = safeRead(join(homedir(), ".claude", "plugins", "installed_plugins.json"));
  if (!txt) return { list, bundles: [], installed: 0, enabled: 0, skipped: 0 };
  // Claude Code loads a plugin's skills only when the merged settings map holds
  // an explicit `true` for its "plugin@marketplace" key: the loader keeps every
  // defined entry but tags it `enabled: key === true`, and skill discovery walks
  // the enabled set only. So `false`, absent, and a missing map alike contribute
  // nothing — an unlisted plugin is never loaded, so there is no "installed =
  // enabled" fallback to make here.
  const enabled = readSettings(cwd).enabledPlugins;
  let installed = 0;
  let skipped = 0;
  try {
    const j = JSON.parse(txt) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    for (const [key, recs] of Object.entries(j.plugins ?? {})) {
      installed++;
      // Keys must be "plugin@marketplace"; the loader drops anything else.
      if (!key.includes("@") || enabled?.get(key) !== true) { skipped++; continue; }
      const ns = key.split("@")[0];
      for (const r of recs) {
        if (r && typeof r.installPath === "string") list.push({ ns, installPath: r.installPath });
      }
    }
  } catch (e) {
    log("startup-inventory: installed_plugins.json parse failed", e);
  }
  if (skipped) log(`startup-inventory: skipped ${skipped} installed-but-not-enabled plugin(s)`);
  // One row per bundle, not per install record: a bundle can resolve to several
  // installPaths (marketplace + local), and the UI counts bundles.
  const byNs = new Map<string, Set<string>>();
  for (const { ns, installPath } of list) {
    const hooks = byNs.get(ns) ?? new Set<string>();
    for (const h of declaredHooks(installPath)) hooks.add(h);
    byNs.set(ns, hooks);
  }
  const bundles = [...byNs].map(([ns, hooks]) => ({ ns, hooks: [...hooks] }));
  return { list, bundles, installed, enabled: installed - skipped, skipped };
}

// Merged settings across scopes (user → project → project local, later wins).
// `enabledPlugins` is null when no scope declares one at all — that means "no
// opinion", not "nothing enabled".
interface MergedSettings {
  enabledPlugins: Map<string, boolean> | null;
  skillListingBudgetFraction?: number;
  skillListingMaxDescChars?: number;
}
// Managed/policy settings dir, mirroring Claude Code's per-platform lookup.
function managedSettingsPath(): string {
  if (process.platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (process.platform === "win32") {
    const pf = join("C:\\Program Files", "ClaudeCode", "managed-settings.json");
    return isFile(pf) ? pf : join("C:\\ProgramData", "ClaudeCode", "managed-settings.json");
  }
  return "/etc/claude-code/managed-settings.json";
}

function readSettings(cwd: string): MergedSettings {
  // Claude Code merge order (later scope wins per key):
  // userSettings → projectSettings → localSettings → flagSettings → policySettings.
  // flagSettings comes from a runtime `--settings` flag, so it is not observable
  // from disk and is skipped; policy (managed) is last and therefore overrides.
  const files = [
    join(homedir(), ".claude", "settings.json"),
    ...(cwd ? [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")] : []),
    managedSettingsPath(),
  ];
  const out: MergedSettings = { enabledPlugins: null };
  for (const f of files) {
    const txt = safeRead(f);
    if (!txt) continue;
    try {
      const j = JSON.parse(txt) as {
        enabledPlugins?: Record<string, boolean>;
        skillListingBudgetFraction?: number;
        skillListingMaxDescChars?: number;
      };
      if (j.enabledPlugins && typeof j.enabledPlugins === "object") {
        out.enabledPlugins ??= new Map<string, boolean>();
        for (const [k, v] of Object.entries(j.enabledPlugins)) out.enabledPlugins.set(k, v === true);
      }
      if (typeof j.skillListingBudgetFraction === "number") {
        out.skillListingBudgetFraction = j.skillListingBudgetFraction;
      }
      if (typeof j.skillListingMaxDescChars === "number") {
        out.skillListingMaxDescChars = j.skillListingMaxDescChars;
      }
    } catch (e) {
      log(`startup-inventory: ${f} parse failed`, e);
    }
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
    const skillCfg = skillListingConfig(key);
    const plugins = enabledPlugins(key); // scan once; both discoverers read it
    inv = {
      skills: discoverSkills(key, skillCfg.maxDescChars, plugins),
      agents: discoverAgents(key, plugins),
      memory: discoverMemory(key),
      rules: discoverRules(key),
      scannedAt: new Date().toISOString(),
      tokenizer: tokenizerProvenance(),
      skillListingConfig: skillCfg,
      plugins: {
        installed: plugins.installed,
        enabled: plugins.enabled,
        skipped: plugins.skipped,
        bundles: plugins.bundles,
      },
    };
  } catch (e) {
    log("startup-inventory: scan failed", e);
    inv = {
      skills: [], agents: [], memory: [], rules: [],
      scannedAt: new Date().toISOString(),
      tokenizer: tokenizerProvenance(),
      skillListingConfig: {
        fraction: SKILL_BUDGET_FRACTION_DEFAULT,
        maxDescChars: SKILL_DESC_CAP_DEFAULT,
        bytesPerToken: SKILL_BYTES_PER_TOKEN,
        envBudgetChars: null,
      },
      plugins: { installed: 0, enabled: 0, skipped: 0, bundles: [] },
    };
  }
  cache = { inv, cwd: key, at: now };
  return inv;
}
