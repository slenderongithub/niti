import { expect, test } from "bun:test";
import { classify } from "./changelog.ts";

test("classify sorts commit subjects by their wording", () => {
  expect(classify(["Add /awake", "Fix startup crash on old databases", "e2e: clean up on exit", "/remote kept the old relay"])).toEqual({
    features: ["Add /awake"],
    fixes: ["Fix startup crash on old databases", "/remote kept the old relay"],
    other: ["e2e: clean up on exit"],
  });
});
