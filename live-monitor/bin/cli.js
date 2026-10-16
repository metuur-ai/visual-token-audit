#!/usr/bin/env node
import { readFileSync } from "node:fs";

const help = `Usage: claude-live-monitor [command]
       codex-live-monitor [command]

Commands:
  start                 Run the monitor in the background
  stop                  Stop the background monitor
  status                Show background monitor state
  version, --version, -v Print the installed package version
  help, --help, -h       Show this help

Without a command, run the monitor in the foreground.
MONITOR_PORT selects the instance (default: 8722).
Both CLI names support the same commands.`;

const command = process.argv[2];
if (["version", "--version", "-v"].includes(command)) {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(version);
} else if (["help", "--help", "-h"].includes(command)) {
  console.log(help);
} else if (!command) {
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
  console.error(`Unknown command: ${command}\n\n${help}`);
  process.exitCode = 1;
}
