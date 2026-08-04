#!/usr/bin/env node
// The headless engine/scripting CLI (`niti-core "task"`, `serve`, `auth`, …). Same handover as
// bin/niti.js — the TUI spawns this binary directly as a sibling, without going through Node.
import { spawnSync } from "node:child_process";
import { binPath } from "./resolve.js";

process.exit(spawnSync(binPath("niti-core"), process.argv.slice(2), { stdio: "inherit" }).status ?? 1);
