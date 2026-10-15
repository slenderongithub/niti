import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventHub } from "./server/events.ts";

// /awake — keep the Mac awake, lid closed too, until the current or next run ends. Lid-closed sleep
// can only be stopped by root (`pmset disablesleep`), so one admin prompt starts a root watchdog that
// restores sleep when our flag file goes away or this process dies — a SIGKILL'd core can't leave
// the Mac unable to sleep. If the prompt is refused, caffeinate keeps it awake with the lid open.

type Elevate = (shell: string) => Promise<boolean>;

const osascript: Elevate = async (shell) => {
  const as = shell.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const p = Bun.spawn(["osascript", "-e", `do shell script "${as}" with administrator privileges`], { stdout: "ignore", stderr: "ignore" });
  return (await p.exited) === 0;
};

let armed: { hub: EventHub; flag: string; unsub: () => void; caffeinate?: { kill(): void } } | undefined;

// What the clients show: rides on /session for a late joiner, and on `awake` events after that.
export function awakeMode(): "off" | "lid" | "open" {
  return !armed ? "off" : armed.caffeinate ? "open" : "lid";
}

export function release(): void {
  if (!armed) return;
  rmSync(armed.flag, { force: true }); // the root watchdog sees this within 2s and restores sleep
  armed.caffeinate?.kill();
  armed.unsub();
  const { hub } = armed;
  armed = undefined;
  hub.publish({ kind: "awake", state: "off" });
}

// pmset's own record. Lid-closed sleep is a Mac-wide setting that outlives whoever turned it off: a
// reboot or a killed watchdog leaves it off with no niti holding it, so /awake off asks the Mac.
export function sleepDisabled(): boolean {
  if (process.platform !== "darwin") return false;
  return /SleepDisabled\s+1/.test(Bun.spawnSync(["pmset", "-g"]).stdout.toString());
}

// /awake off: drop this core's hold, then make sure the Mac can really sleep again. `elevate` is null
// from a phone, where nobody is at the Mac to answer the admin prompt.
export async function off(elevate: Elevate | null = osascript, disabled = sleepDisabled): Promise<{ ok: boolean; message: string }> {
  const lid = awakeMode() === "lid";
  release();
  for (let i = 0; lid && disabled() && i < 6; i++) await Bun.sleep(500); // our watchdog restores it within 2s
  if (!disabled()) return { ok: true, message: "awake off — normal sleep restored" };
  const leftover = "lid-closed sleep was still off, left over from an earlier /awake";
  if (!elevate) return { ok: false, message: `${leftover} — run /awake off on the Mac to restore it` };
  if (await elevate("pmset -a disablesleep 0")) return { ok: true, message: `awake off — ${leftover}; restored` };
  return { ok: false, message: `${leftover}, and the admin prompt was declined (sudo pmset -a disablesleep 0 restores it)` };
}

// `keep`: while it says true, a run ending doesn't release — /goal holds sleep off across all its
// rounds and lets go when the goal itself ends (its `goal` event).
export async function arm(hub: EventHub, elevate: Elevate = osascript, keep: () => boolean = () => false): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== "darwin") return { ok: false, message: "/awake is macOS only" };
  if (armed) return { ok: true, message: "already awake — sleep comes back when the run finishes" };
  const flag = join(tmpdir(), `niti-awake-${process.pid}`);
  writeFileSync(flag, "");
  const watch = `while kill -0 ${process.pid} 2>/dev/null && [ -e "${flag}" ]; do sleep 2; done; pmset -a disablesleep 0`;
  // The redirect + & matter: without them `do shell script` waits for the watchdog to exit.
  const root = await elevate(`pmset -a disablesleep 1 || exit 1; nohup sh -c '${watch}' >/dev/null 2>&1 &`);
  const unsub = hub.subscribe((e) => {
    if (keep()) return;
    if ((e.kind === "session" && (e.state === "ended" || e.state === "cancelled")) || e.kind === "goal") release();
  });
  if (root) {
    armed = { hub, flag, unsub };
    hub.publish({ kind: "awake", state: "lid" });
    return { ok: true, message: "awake — lid can close; normal sleep returns when the run finishes (/awake off to stop now)" };
  }
  const caffeinate = Bun.spawn(["caffeinate", "-i", "-w", String(process.pid)], { stdout: "ignore", stderr: "ignore" });
  armed = { hub, flag, unsub, caffeinate };
  hub.publish({ kind: "awake", state: "open" });
  return { ok: true, message: "awake, lid-open only (admin prompt declined) — closing the lid will still sleep" };
}
