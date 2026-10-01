#!/usr/bin/env node
// The interactive TUI. Node runs this shim; everything after the handover is Go and Bun.
import { run } from "./resolve.js";

run("niti");
