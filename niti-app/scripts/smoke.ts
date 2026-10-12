// Launch the real app (Electron + niti-core + the fake model), let it open a project, pass the
// trust prompt, keep the team, render every page, and report. Exit 0 only on a clean run: no
// crashed page, no console error. Run after `npm run build`.
//   bun scripts/smoke.ts            # the built app (out/)
//   bun scripts/smoke.ts --packaged # release/mac*/niti.app
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./fixture";

const APP = join(import.meta.dir, "..");
const packaged = process.argv.includes("--packaged");
const fx = await fixture();

let cmd: string[];
if (packaged) {
  const rel = join(APP, "release");
  // electron-builder names the x64 build "mac" and the arm64 one "mac-arm64": test this machine's.
  const want = process.arch === "arm64" ? "mac-arm64" : "mac";
  const dir = [want, ...readdirSync(rel)].find((d) => d.startsWith("mac") && existsSync(join(rel, d, "niti.app")));
  if (!dir) throw new Error("no packaged app in release/ — run npm run dist first");
  cmd = [join(rel, dir, "niti.app/Contents/MacOS/niti")];
} else {
  const electron = (await import("electron")).default as unknown as string;
  cmd = [electron, APP];
}

const proc = Bun.spawn(cmd, {
  env: { ...process.env, ...fx.env, NITI_APP_SMOKE: fx.project, ELECTRON_ENABLE_LOGGING: "0" },
  stdout: "pipe",
  stderr: "pipe",
});
const code = await proc.exited;
const out = await new Response(proc.stdout).text();
const err = await new Response(proc.stderr).text();
fx.stop();
const verdict = out.split("\n").find((l) => l.startsWith("smoke:")) ?? "";
console.log(out.trim());
if (code !== 0) console.error(err.split("\n").filter((l) => !/^\[\d+:\d+\//.test(l) && l.trim()).slice(-40).join("\n"));
console.log(`\nsmoke exit ${code}${verdict ? "" : " (no verdict line)"}  project ${fx.project}`);
process.exit(code === 0 && verdict.includes("PASS") ? 0 : 1);
