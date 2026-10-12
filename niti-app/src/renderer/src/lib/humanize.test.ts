import { expect, test } from "bun:test";
import { describeCall, fmtDur, groupLabel, noteFor, parseCall } from "./humanize";

test("calls read as sentences", () => {
  expect(describeCall("read_file", '{"path":"src/a.ts"}')).toEqual({ verb: "Read", target: "src/a.ts" });
  expect(describeCall("shell", '{"command":"npm","args":["run","build"]}')).toEqual({ verb: "Run", target: "npm run build" });
  expect(describeCall("grep", '{"pattern":"TODO"}')).toEqual({ verb: "Search", target: "TODO" });
  // cut at 180 chars by the core: the regex still finds the path
  expect(describeCall("edit", '{"path":"src/very/long.ts","oldString":"abc')).toEqual({ verb: "Edit", target: "src/very/long.ts" });
  expect(describeCall("shell", '{"args":["x"],"comm')).toEqual({ verb: "Run", target: "a command" });
  expect(describeCall("mcp__gh__create_issue", "{}").verb).toBe("Create issue");
  expect(parseCall('read_file {"path":"a"}')).toEqual({ name: "read_file", args: '{"path":"a"}' });
});

test("notes take the TUI's tones", () => {
  expect(noteFor("thought", "received 2 message(s)")).toBeNull();
  expect(noteFor("thought", "verifying: tsc")).toMatchObject({ tone: "step" });
  expect(noteFor("thought", "starting t1 → dev: build it")).toEqual({ tone: "step", text: "t1: build it" });
  expect(noteFor("warning", "context 80% full")).toMatchObject({ tone: "warning" });
  expect(noteFor("error", "error: 403 forbidden")).toMatchObject({ tone: "error", text: "403 forbidden", keyError: true });
});

test("durations and groups", () => {
  expect(fmtDur(1234)).toBe("1.2s");
  expect(fmtDur(42_000)).toBe("42s");
  expect(fmtDur(65_000)).toBe("1m05s");
  expect(groupLabel("Read", 3, "")).toBe("Read 3 files");
  expect(groupLabel("Read", 1, "a.ts")).toBe("Read a.ts");
  expect(groupLabel("Run", 2, "")).toBe("Ran 2 shell commands");
});
