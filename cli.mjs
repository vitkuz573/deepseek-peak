#!/usr/bin/env node
// deepseek-peak CLI entry point. All logic lives in lib/commands.mjs
// (import-safe) so tests can drive it in-process; this file only wires
// argv in and the exit code out. Run `deepseek-peak --help` for usage.
import { main } from "./lib/commands.mjs";

process.exitCode = await main(process.argv.slice(2));
