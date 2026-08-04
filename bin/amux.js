#!/usr/bin/env node
// The interactive TUI. Node runs this shim; everything after the handover is Go and Bun.
import { spawnSync } from "node:child_process";
import { binPath } from "./resolve.js";

process.exit(spawnSync(binPath("amux"), process.argv.slice(2), { stdio: "inherit" }).status ?? 1);
