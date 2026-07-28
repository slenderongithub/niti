import React from "react";
import { Box, Text } from "ink";
import type { AgentConfig } from "../agent/agent.ts";
import type { UsageTracker } from "../usage.ts";
import { contextWindow } from "../providers/catalog.ts";
import { theme, agentColor, agentAvatar } from "./theme.ts";

const fmt = (n: number) => n.toLocaleString("en-US");

function ctxBarColor(pct: number): string {
  if (pct > 80) return theme.error;
  if (pct >= 50) return theme.warning;
  return theme.success;
}

// RateLimit only ever tracks *remaining* counts, never the account's total quota, so a true
// "% remaining" isn't computable — low remaining requests is the same proxy agent.ts already
// warns on mid-run, just a looser threshold since this is a passive glance, not an interrupt.
const LOW_REQUESTS = 5;

export function UsageView({ configs, usage }: { configs: AgentConfig[]; usage: UsageTracker }) {
  const rows = usage.snapshot();
  const totals = usage.totals();
  const rls = usage.rateLimits_();
  const max = Math.max(1, ...rows.map((r) => r.usage.inputTokens + r.usage.outputTokens));
  const bar = (n: number) => "█".repeat(Math.round((n / max) * 16));

  const header =
    "agent".padEnd(13) + "in".padStart(9) + "out".padStart(8) + "total".padStart(10) + "calls".padStart(7) + "ctx".padStart(9);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.success} marginTop={1} paddingX={1}>
      <Text bold color={theme.success}>
        Usage &amp; Stats (/usage to toggle)
      </Text>
      <Text dimColor>{header}</Text>
      {rows.length === 0 ? (
        <Text dimColor>(no usage yet — run a task)</Text>
      ) : (
        rows.map((r) => {
          const color = agentColor(configs, r.agentId);
          const avatar = agentAvatar(configs, r.agentId);
          const total = r.usage.inputTokens + r.usage.outputTokens;
          const label = `${avatar} ${r.agentId}`.slice(0, 13).padEnd(13);
          const cfg = configs.find((c) => c.id === r.agentId);
          const ctxPct = cfg ? Math.round((r.usage.lastInput / contextWindow(cfg.provider)) * 100) : 0;
          return (
            <Text key={r.agentId} color={color}>
              {label}
              {fmt(r.usage.inputTokens).padStart(9)}
              {fmt(r.usage.outputTokens).padStart(8)}
              {fmt(total).padStart(10)}
              {String(r.usage.calls).padStart(7)}
              {`ctx ${ctxPct}%`.padStart(9)} <Text color={ctxBarColor(ctxPct)}>{bar(total)}</Text>
            </Text>
          );
        })
      )}
      <Text bold>
        {"total".padEnd(13)}
        {fmt(totals.inputTokens).padStart(9)}
        {fmt(totals.outputTokens).padStart(8)}
        {fmt(totals.inputTokens + totals.outputTokens).padStart(10)}
        {String(totals.calls).padStart(7)}
      </Text>
      {rls.map((rl) => {
        const low = rl.remainingRequests != null && rl.remainingRequests <= LOW_REQUESTS;
        return (
          <Text key={rl.provider} color={low ? theme.warning : undefined} dimColor={!low}>
            {low ? "⚠ " : ""}
            rate limit ({rl.provider}): {rl.remainingTokens != null ? fmt(rl.remainingTokens) : "?"} tokens ·{" "}
            {rl.remainingRequests ?? "?"} req remaining
          </Text>
        );
      })}
    </Box>
  );
}
