import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// Run the shipped dashboard script with a small DOM/SSE harness, without
// introducing a browser dependency into the collector's test suite.
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style = {};
  textContent: any = "";
  className = "";
  listeners: Record<string, Function> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  constructor(public tag = "") {}
  set innerHTML(_: string) { this.children = []; }
  get cells() { return this.children; }
  get firstChild() { return this.children[0]; }
  appendChild(child: Element) { this.children.push(child); return child; }
  insertBefore(child: Element) { this.children.unshift(child); }
  replaceChildren(...children: Element[]) { this.children = children; }
  addEventListener(name: string, callback: Function) { this.listeners[name] = callback; }
  setAttribute() {}
  querySelectorAll(selector: string): Element[] {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
    if (selector === "*") return all;
    if (selector === "tr[data-sid]") return all.filter(child => child.tag === "tr" && child.dataset.sid);
    return [];
  }
  querySelector(selector: string) {
    const sid = selector.match(/^tr\[data-sid="(.*)"\]$/)?.[1];
    return sid ? this.querySelectorAll("tr[data-sid]").find(row => row.dataset.sid === sid) : null;
  }
}

const session = (sessionId: string, extra = {}) => ({
  sessionId, provider: "codex", project: "demo",
  firstTs: "2026-10-25T12:00:00Z", lastTs: "2026-10-25T12:00:00Z",
  events: 1, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }, ...extra,
});

async function dashboard(rows: any[]) {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  let stream: any;
  let refresh: Function | undefined;
  const requests: string[] = [];
  const context = createContext({
    document: {
      getElementById: (id: string) => element(id),
      querySelector: () => null,
      addEventListener() {},
      createElement: (tag: string) => new Element(tag),
      createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }),
    },
    window: { addEventListener() {} },
    CSS: { escape: (value: string) => value },
    setInterval() {}, clearTimeout() {},
    setTimeout(callback: Function) { refresh = callback; return 1; },
    fetch: async (url: string) => {
      requests.push(url);
      if (url !== "/api/snapshot") return new Promise(() => {});
      return { ok: true, json: async () => ({ sessions: rows, events: [] }) };
    },
    EventSource: class {
      listeners: Record<string, Function> = {};
      constructor() { stream = this; }
      addEventListener(name: string, callback: Function) { this.listeners[name] = callback; }
    },
  });
  runInContext(readFileSync(new URL("../public/app.js", import.meta.url), "utf8"), context);
  // Let snapshot loading and SSE connection finish.
  await new Promise<void>(resolve => setImmediate(resolve));
  return {
    element, requests,
    ids: () => element("sessions-body").children.map(row => row.dataset.sid).filter(Boolean),
    event: (ev: any) => stream.listeners.message({ data: JSON.stringify({ ts: "2026-10-25T12:01:00Z", kind: "assistant", project: "demo", provider: "codex", ...ev }) }),
    refresh: () => refresh?.(),
    filter: (provider: string) => element("provider-filter").listeners.change({ target: { value: provider } }),
    search: (value: string) => element("session-search").listeners.input({ target: { value } }),
  };
}

test("dashboard lists only Codex parents and counts their rows while retaining all usage", async () => {
  const app = await dashboard([
    session("codex:parent"),
    session("codex:child", { parentSessionId: "codex:parent" }),
    session("codex:guardian", { parentSessionId: "codex:child", agentName: "guardian" }),
    session("codex:independent"),
    session("claude-main", { provider: "claude" }),
  ]);
  expect(app.ids()).toEqual(["codex:parent", "codex:independent", "claude-main"]);
  expect(app.element("t-sessions").textContent).toBe(3);
  expect(app.element("t-input").textContent).toBe("50");
  app.filter("codex");
  expect(app.ids()).toEqual(["codex:parent", "codex:independent"]);
  expect(app.element("t-sessions").textContent).toBe(2);
  expect(app.element("t-input").textContent).toBe("40");
  app.filter("claude");
  expect(app.ids()).toEqual(["claude-main"]);
});

test("live children stay inside their parent and refresh its open detail", async () => {
  const app = await dashboard([session("codex:parent")]);
  app.element("sessions-body").children[0].listeners.click();
  app.event({ sessionId: "codex:child", parentSessionId: "codex:parent" });
  app.event({ sessionId: "codex:grandchild", parentSessionId: "codex:child" });
  app.event({ sessionId: "codex:child", usage: { input: 5 } });
  expect(app.ids()).toEqual(["codex:parent"]);
  expect(app.element("t-sessions").textContent).toBe(1);
  app.refresh();
  expect(app.requests.filter(url => url === "/api/session/codex%3Aparent")).toHaveLength(2);
});

test("a late parent relationship removes an existing child row", async () => {
  const app = await dashboard([session("codex:parent"), session("codex:child")]);
  app.event({ sessionId: "codex:child", parentSessionId: "codex:parent" });
  expect(app.ids()).toEqual(["codex:parent"]);
});

test("a malformed self-parent link cannot hide a main session", async () => {
  const app = await dashboard([session("codex:main", { parentSessionId: "codex:main" })]);
  expect(app.ids()).toEqual(["codex:main"]);
});

test("dashboard rows show session slugs, fall back to names or IDs, and update live", async () => {
  const app = await dashboard([
    session("codex:first", { slug: "steady-copper-fox", sessionName: "Saved name" }),
    session("codex:second", { sessionName: "Review local loom" }),
    session("codex:third-session"),
  ]);
  const labels = () => app.element("sessions-body").children.map(row => row.cells[0].children[1]?.textContent);
  expect(labels()).toEqual(["steady-copper-fox", "Review local loom", "third-se"]);
  app.event({ sessionId: "codex:first", slug: "updated-session-slug" });
  expect(labels()[0]).toBe("updated-session-slug");
});

test("dashboard search matches directory, saved name, project, slug and session ID", async () => {
  const app = await dashboard([
    session("codex:work", { cwd: "/Users/dev/billing-api", sessionName: "Repair invoices", slug: "steady-copper-fox" }),
    session("claude-other", { provider: "claude", project: "website", projectSlug: "-Users-dev-web-client" }),
    session("codex:child", { parentSessionId: "codex:work" }),
  ]);
  for (const query of ["BILLING-API", "repair INVOICES", "copper-fox", "codex:work", "billing invoices"]) {
    app.search(query);
    expect(app.ids()).toEqual(["codex:work"]);
    expect(app.element("t-input").textContent).toBe("20");
  }
  for (const query of ["website", "web-client"]) {
    app.search(query);
    expect(app.ids()).toEqual(["claude-other"]);
  }
  app.filter("codex");
  expect(app.ids()).toEqual([]);
  app.search("missing");
  expect(app.element("sessions-body").children[0].children[0].textContent).toBe("No sessions match your search.");
  app.search("  ");
  expect(app.ids()).toEqual(["codex:work"]);
  app.filter("all");
  expect(app.ids()).toEqual(["codex:work", "claude-other"]);
});

test("search responds to live metadata and preserves directory fields across events", async () => {
  const app = await dashboard([session("codex:work", { cwd: "/tmp/original" })]);
  app.search("renamed");
  expect(app.ids()).toEqual([]);
  app.event({ sessionId: "codex:work", sessionName: "Renamed session", metadataOnly: true });
  expect(app.ids()).toEqual(["codex:work"]);
  expect(app.element("t-events").textContent).toBe("1");
  expect(app.element("feed-list").children).toHaveLength(0);
  app.event({ sessionId: "codex:new", cwd: "/tmp/renamed-project", slug: "new-slug" });
  expect(app.ids()).toEqual(["codex:new", "codex:work"]);
  app.search("original");
  expect(app.ids()).toEqual(["codex:work"]);
  app.event({ sessionId: "codex:work", cwd: "/tmp/moved", slug: "live-slug" });
  expect(app.ids()).toEqual([]);
  app.search("live-slug");
  expect(app.ids()).toEqual(["codex:work"]);
});
