// Measure how the real app feels: click → page shown, keystroke → paint, dialog open, a streamed
// run's long tasks, and idle CPU per page — through real input events. Fails over budget.
//   npm run build && bun scripts/perf.ts      # the built app
//   bun scripts/perf.ts --packaged            # release/mac-<arch>/niti.app
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./fixture";

const APP = join(import.meta.dir, "..");
const packaged = process.argv.includes("--packaged");
const fx = await fixture({ chunked: true });

let cmd: string[];
if (packaged) {
  const rel = join(APP, "release");
  const want = process.arch === "arm64" ? "mac-arm64" : "mac";
  const dir = [want, ...readdirSync(rel)].find((d) => d.startsWith("mac") && existsSync(join(rel, d, "niti.app")));
  if (!dir) throw new Error("no packaged app in release/ — run npm run dist:dir first");
  cmd = [join(rel, dir, "niti.app/Contents/MacOS/niti")];
} else {
  cmd = [(await import("electron")).default as unknown as string, APP];
}

const proc = Bun.spawn(cmd, { env: { ...process.env, ...fx.env, NITI_APP_PERF: fx.project }, stdout: "pipe", stderr: "pipe" });
const code = await proc.exited;
const out = await new Response(proc.stdout).text();
const err = await new Response(proc.stderr).text();
fx.stop();
console.log(out.trim());
if (!out.includes("perf:")) console.error(err.split("\n").filter((l) => l.trim() && !/^\[\d+:\d+\//.test(l)).slice(-30).join("\n"));
process.exit(code);
