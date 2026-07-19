// Project-centric grouping fold for the /api/projects endpoint.
//
// Pure, zero-dependency, no disk access: folds an in-memory SessionAgg collection
// into project-grouped records. Kept in its own module (not inside collector.ts)
// so the grouping semantics are unit-testable without booting the HTTP server.
//
// Grouping semantics (docs/ears/live-monitor-project-index-page.md, Unit 5):
//   - key  = cwd when a non-empty string (R-5.1), else project basename when
//            truthy (R-5.2), else the literal "(unknown)" (R-5.7).
//   - name = project basename of the members (R-5.4), else "(unknown)".
// Derived solely from SessionAgg.cwd / SessionAgg.project — no disk scan / slug
// recovery (R-5.5). Distinct dirs sharing a basename collide by design (R-5.6).

export const UNKNOWN_KEY = "(unknown)";

// The subset of SessionAgg fields the fold consumes. Structurally compatible with
// collector.ts's SessionAgg (which carries these plus more).
export interface ProjectUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface FoldSession {
  sessionId: string;
  project: string;
  cwd?: string;
  firstTs: string;
  lastTs: string;
  prompts: number;
  usage: ProjectUsage;
  tools: Record<string, number>;
  skills: Record<string, number>;
}

export interface ProjectSessionRecord {
  sessionId: string;
  lastTs: string;
  prompts: number;
  usage: ProjectUsage;
}
export interface TopTool {
  name: string;
  count: number;
}
export interface ProjectRecord {
  key: string;
  name: string;
  cwd: string;
  firstActivity: string;
  lastActivity: string;
  sessionCount: number;
  prompts: number;
  usage: ProjectUsage;
  topTools: TopTool[];
  sessions: ProjectSessionRecord[];
}
export interface ProjectsEnvelope {
  projects: ProjectRecord[];
  startedAt: string;
}

// R-5.1 / R-5.2 / R-5.7: cwd → project basename → "(unknown)".
export function projectGroupKey(s: FoldSession): string {
  if (typeof s.cwd === "string" && s.cwd.length > 0) return s.cwd;
  if (typeof s.project === "string" && s.project.length > 0) return s.project;
  return UNKNOWN_KEY;
}

// R-5.4 / R-5.7: display name is the project basename, else "(unknown)".
export function projectDisplayName(s: FoldSession): string {
  if (typeof s.project === "string" && s.project.length > 0) return s.project;
  return UNKNOWN_KEY;
}

// Field-wise usage sum (R-1.14): a naive object add would be a bug — each field
// is accumulated independently.
function addUsage(into: ProjectUsage, u: ProjectUsage): void {
  into.input += u.input || 0;
  into.output += u.output || 0;
  into.cacheRead += u.cacheRead || 0;
  into.cacheWrite += u.cacheWrite || 0;
}

// Merge frequency maps (tools + skills) and emit the top entries as {name,count}[]
// sorted by count desc, ties by name asc, capped at 5 (R-1.14).
function topTools(freq: Record<string, number>): TopTool[] {
  const entries = Object.entries(freq).map(([name, count]) => ({ name, count }));
  entries.sort((a, b) => (b.count - a.count) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries.slice(0, 5);
}

// Fold a SessionAgg collection into the {projects, startedAt} envelope.
// Pure: no disk access, derives only from the passed-in sessions (R-1.9, R-1.16).
export function foldProjects(sessionsIter: Iterable<FoldSession>, startedAt: string): ProjectsEnvelope {
  const groups = new Map<string, FoldSession[]>();
  for (const s of sessionsIter) {
    const key = projectGroupKey(s);
    let members = groups.get(key);
    if (!members) { members = []; groups.set(key, members); }
    members.push(s);
  }

  const projects: ProjectRecord[] = [];
  for (const [key, members] of groups) {
    const usage: ProjectUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const freq: Record<string, number> = {};
    let prompts = 0;
    let cwd = "";
    let name = UNKNOWN_KEY;
    let lastActivity = "";
    let firstActivity = "";

    for (const m of members) {
      addUsage(usage, m.usage);
      prompts += m.prompts || 0;
      for (const [t, c] of Object.entries(m.tools || {})) freq[t] = (freq[t] || 0) + c;
      for (const [t, c] of Object.entries(m.skills || {})) freq[t] = (freq[t] || 0) + c;
      // cwd subtitle: first member that carries a non-empty cwd.
      if (!cwd && typeof m.cwd === "string" && m.cwd.length > 0) cwd = m.cwd;
      // name: first member with a non-empty project basename (R-5.4).
      if (name === UNKNOWN_KEY) {
        const dn = projectDisplayName(m);
        if (dn !== UNKNOWN_KEY) name = dn;
      }
      if (lastActivity === "" || m.lastTs > lastActivity) lastActivity = m.lastTs;
      if (firstActivity === "" || m.firstTs < firstActivity) firstActivity = m.firstTs;
    }

    // R-1.7: sessions by lastTs desc, ties by sessionId asc.
    const sessions: ProjectSessionRecord[] = members
      .map((m) => ({
        sessionId: m.sessionId,
        lastTs: m.lastTs,
        prompts: m.prompts || 0,
        usage: {
          input: m.usage.input || 0,
          output: m.usage.output || 0,
          cacheRead: m.usage.cacheRead || 0,
          cacheWrite: m.usage.cacheWrite || 0,
        },
      }))
      .sort((a, b) =>
        a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 :
        (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
      );

    projects.push({
      key,
      name,
      cwd,
      firstActivity,
      lastActivity,
      sessionCount: members.length,
      prompts,
      usage,
      topTools: topTools(freq),
      sessions,
    });
  }

  // R-1.6: projects by lastActivity desc, ties by key asc.
  projects.sort((a, b) =>
    a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 :
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  return { projects, startedAt };
}
