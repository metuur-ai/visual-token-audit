// ----------------------------------------------------------------------------
// HTTP + SSE server
// ----------------------------------------------------------------------------



import { existsSync, readFileSync } from "fs";
import { createServer } from "http";
import { join } from "path";
import { Readable } from "stream";
import { KEEPALIVE_MS, startedAt } from "./config.ts";
import { buildObserveSnapshot } from "./observe.ts";
import { buildProjectsJSON } from "./projects-endpoint.ts";
import { buildSessionDetail } from "./session-detail.ts";
import { clients, ring, sessions } from "./state.ts";
import { buildStatsJSON } from "./stats.ts";
import { MonitorEvent } from "./types.ts";
import { log } from "./util.ts";

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

// Build and start the HTTP+SSE server. publicDir is resolved by the entry
// module (collector.ts) so this module stays free of import.meta.
export function startHttpServer(opts: { host: string; port: number; publicDir: string }): { port: number } {
  const { host, port, publicDir } = opts;

  function serveStatic(file: string, contentType: string): Response {
    const path = join(publicDir, file);
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

  return startServer({
    hostname: host,
    port,
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
      // ?days=N clamped to 1..60, default 30. The in-memory sessions map only
      // spans ~48h, so history beyond that comes from an on-disk scan over the
      // window (buildProjectsJSON). Envelope {projects, startedAt, days}.
      const dq = url.searchParams.get("days");
      const n = dq === null ? 30 : Math.floor(Number(dq));
      const days = Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : 30;
      return new Response(buildProjectsJSON(days), {
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
}
