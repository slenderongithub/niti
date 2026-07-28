import { test, expect } from "bun:test";
import { interpretPollResponse } from "./copilot.ts";

// The auth-critical branch: how a device-flow poll response is interpreted.
test("interpretPollResponse handles every device-flow outcome", () => {
  expect(interpretPollResponse({ access_token: "gho_abc" })).toEqual({ done: "gho_abc" });
  expect(interpretPollResponse({ error: "authorization_pending" })).toEqual({ pending: true });
  expect(interpretPollResponse({ error: "slow_down" })).toEqual({ slowDown: true });
  expect(interpretPollResponse({ error: "access_denied" })).toEqual({ error: "access_denied" });
  expect(interpretPollResponse({})).toEqual({ error: "unknown" });
});
