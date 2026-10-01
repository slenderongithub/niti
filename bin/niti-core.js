#!/usr/bin/env node
// The headless engine/scripting CLI (`niti-core "task"`, `serve`, `auth`, …). Same handover as
// bin/niti.js — the TUI spawns this binary directly as a sibling, without going through Node.
import { run } from "./resolve.js";

run("niti-core");
