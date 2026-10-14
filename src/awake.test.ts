import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { arm, release, awakeMode } from "./awake.ts";
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
