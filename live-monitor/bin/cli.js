#!/usr/bin/env node
const command = process.argv[2];
if (!command) {
  await import("../dist/collector.js");
} else if (["start", "stop", "status"].includes(command)) {
  try {
    const { serviceCommand } = await import("./service.js");
    await serviceCommand(command);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  console.log("Usage: claude-live-monitor [start|stop|status]\nNo command: run in foreground.\nstart: run in background; stop: stop background service; status: show state.\nMONITOR_PORT selects the instance (default 8722). codex-live-monitor supports the same commands.");
  if (!["--help", "-h", "help"].includes(command)) process.exitCode = 1;
}
