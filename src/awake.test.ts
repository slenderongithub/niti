import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { arm, release, awakeMode, off } from "./awake.ts";
import { EventHub } from "./server/events.ts";

test.skipIf(process.platform !== "darwin")("/awake starts a root watchdog and releases when the run ends", async () => {
  const hub = new EventHub();
  const states: string[] = [];
  hub.subscribe((e) => e.kind === "awake" && states.push(e.state));
  let script = "";
  const elevate = async (s: string) => ((script = s), true);

  expect((await arm(hub, elevate)).message).toContain("lid can close");
  expect(script).toContain("pmset -a disablesleep 1");
  expect(script).toContain(`kill -0 ${process.pid}`);
  const flag = script.match(/-e "([^"]+)"/)![1]!;
  expect(existsSync(flag)).toBe(true);
  expect(awakeMode()).toBe("lid");
  expect((await arm(hub, elevate)).message).toContain("already awake");

  hub.publish({ kind: "session", state: "started" });
  expect(existsSync(flag)).toBe(true); // a run starting must not release it
  hub.publish({ kind: "session", state: "ended" });
  expect(existsSync(flag)).toBe(false);

  expect((await arm(hub, elevate)).message).toContain("lid can close"); // re-armable
  release();
  expect(existsSync(flag)).toBe(false);
  expect(awakeMode()).toBe("off");
  expect(states).toEqual(["lid", "off", "lid", "off"]); // what the TUI/app indicators follow
});

test.skipIf(process.platform !== "darwin")("/awake holds across a goal's rounds and lets go when the goal ends", async () => {
  const hub = new EventHub();
  let goalRunning = true;
  let script = "";
  await arm(hub, async (s) => ((script = s), true), () => goalRunning);
  const flag = script.match(/-e "([^"]+)"/)![1]!;
  hub.publish({ kind: "session", state: "ended" }); // round 1 ends
  expect(existsSync(flag)).toBe(true);
  goalRunning = false;
  hub.publish({ kind: "goal", status: null }); // the goal ends
  expect(existsSync(flag)).toBe(false);
  expect(awakeMode()).toBe("off");
});

test("/awake off restores lid-closed sleep an earlier /awake left off, with nothing armed here", async () => {
  let disabled = true;
  let script = "";
  const r = await off(async (s) => ((script = s), (disabled = false), true), () => disabled);
  expect(script).toBe("pmset -a disablesleep 0");
  expect(r).toMatchObject({ ok: true, message: expect.stringContaining("left over") });

  disabled = true; // from a phone: no admin prompt, and it doesn't claim sleep is back
  expect(await off(null, () => disabled)).toMatchObject({ ok: false, message: expect.stringContaining("on the Mac") });

  disabled = false; // nothing left over: no prompt
  let asked = false;
  expect((await off(async () => (asked = true), () => disabled)).ok).toBe(true);
  expect(asked).toBe(false);
});
