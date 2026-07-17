#!/usr/bin/env node
// npx entry point. The collector boots on import (starts the watcher + server).
// Honors MONITOR_PORT from the environment; host is always 127.0.0.1.
import "../dist/collector.js";
