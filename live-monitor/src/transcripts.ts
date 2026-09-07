import { basename, relative } from "path";
import { CODEX_SESSION_DIRS } from "./config.ts";
import { CodexAdapter } from "./codex.ts";

export function isCodexFile(path: string): boolean {
  return CODEX_SESSION_DIRS.some(root => {
    const rel = relative(root, path);
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
  });
}

export function transcriptAdapter(path: string): (raw: string) => string | null {
  if (!isCodexFile(path)) return raw => raw;
  const id = basename(path, ".jsonl").match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i)?.[0] ?? basename(path, ".jsonl");
  const adapter = new CodexAdapter(id);
  return raw => adapter.convert(raw);
}

// Historical scans use the exact same normalization as live ingestion. Consume
// metadata/counters BEFORE filtering timestamps, so window boundaries stay exact.
export function* transcriptLines(path: string, raw: string): Generator<string> {
  const adapt = transcriptAdapter(path);
  let start = 0;
  for (let end; (end = raw.indexOf("\n", start)) !== -1; start = end + 1) {
    const line = adapt(raw.slice(start, end));
    if (line) yield line;
  }
  // An incomplete trailing record belongs to the next append.
}
