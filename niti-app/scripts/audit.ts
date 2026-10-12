// The layout test: launches the app (NITI_APP_AUDIT) and prints every geometry violation —
// clipped content, overflow, unequal boxes, misaligned edges, uneven gaps, tiny targets.
//   npm run build && bun scripts/audit.ts      # the built app
//   bun scripts/audit.ts --packaged
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./fixture";

const APP = join(import.meta.dir, "..");
const fx = await fixture();
let cmd: string[];
if (process.argv.includes("--packaged")) {
  const rel = join(APP, "release");
  const want = process.arch === "arm64" ? "mac-arm64" : "mac";
  const dir = [want, ...readdirSync(rel)].find((d) => d.startsWith("mac") && existsSync(join(rel, d, "niti.app")));
  if (!dir) throw new Error("no packaged app in release/");
  cmd = [join(rel, dir, "niti.app/Contents/MacOS/niti")];
} else cmd = [(await import("electron")).default as unknown as string, APP];
const proc = Bun.spawn(cmd, { env: { ...process.env, ...fx.env, NITI_APP_AUDIT: fx.project }, stdout: "pipe", stderr: "pipe" });
const code = await proc.exited;
const out = await new Response(proc.stdout).text();
const err = await new Response(proc.stderr).text();
fx.stop();
console.log(out.trim());
if (!out.includes("audit:")) console.error(err.split("\n").filter((l) => l.trim() && !/^\[\d+:\d+\//.test(l)).slice(-30).join("\n"));
process.exit(code);
