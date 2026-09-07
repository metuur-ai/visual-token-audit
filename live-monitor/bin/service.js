import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

async function openBrowser(url) {
  if (process.env.MONITOR_OPEN_BROWSER === "0") return;
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  await new Promise(resolve => {
    const opener = spawn(command, args, { stdio: "ignore", timeout: 5000 });
    let finished = false;
    const finish = success => {
      if (finished) return;
      finished = true;
      if (!success) console.warn(`Could not open the default browser. Open ${url} manually.`);
      resolve();
    };
    opener.once("error", () => finish(false));
    opener.once("exit", code => finish(code === 0));
  });
}

export async function serviceCommand(command) {
  const port = Number(process.env.MONITOR_PORT ?? 8722);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MONITOR_PORT must be between 1 and 65535.");
  const dir = process.env.MONITOR_STATE_DIR ?? join(homedir(), ".claude-live-monitor");
  const statePath = join(dir, `${port}.json`);
  const logPath = join(dir, `${port}.log`);
  const url = `http://127.0.0.1:${port}`;
  let state;
  try { state = JSON.parse(readFileSync(statePath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  async function control(token, method = "GET") {
    if (!token) return false;
    try {
      const response = await fetch(`${url}/api/service`, {
        method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000),
      });
      return response.ok && (await response.json()).service === "live-monitor";
    } catch { return false; }
  }
  function clearState() {
    try {
      if (JSON.parse(readFileSync(statePath, "utf8")).token === state?.token) unlinkSync(statePath);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const running = await control(state?.token);
  if (command === "status") {
    console.log(`${running ? `Running (PID ${state.pid}).` : "Background service is stopped."}\nURL: ${url}\nLog: ${logPath}`);
    process.exitCode = running ? 0 : 1;
    return;
  }
  if (command === "stop") {
    if (!running) { console.log(`Background service is already stopped on port ${port}.`); return; }
    if (!await control(state.token, "POST")) throw new Error("Could not request service shutdown; try again.");
    for (let i = 0; i < 50; i++) {
      await delay(100);
      if (!await control(state.token)) {
        clearState();
        console.log(`Stopped background service on port ${port}.`);
        return;
      }
    }
    throw new Error("Service has not stopped yet; check status and the log.");
  }
  if (running) {
    console.log(`Already running at ${url} (PID ${state.pid}).`);
    await openBrowser(url);
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const log = openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("cli.js", import.meta.url))], {
      detached: true, stdio: ["ignore", log, log],
      env: { ...process.env, MONITOR_PORT: String(port), MONITOR_SERVICE_TOKEN: token },
    });
  } finally { closeSync(log); }
  let failure;
  child.on("error", error => { failure = error.message; });
  child.on("exit", (code, signal) => { failure = `Service exited (${signal ?? code}).`; });
  for (let i = 0; i < 300; i++) {
    if (failure) break;
    if (await control(token)) {
      const temporary = `${statePath}.${token}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ pid: child.pid, token, port }), { mode: 0o600 });
        renameSync(temporary, statePath);
      } catch (error) { child.kill(); throw error; }
      child.unref();
      console.log(`Started background service at ${url} (PID ${child.pid}).\nLog: ${logPath}`);
      await openBrowser(url);
      return;
    }
    await delay(100);
  }
  child.kill();
  throw new Error(`${failure ?? "Service startup timed out."} Check ${logPath} (the port may already be in use).`);
}
