// Accumulates token usage per agent and the latest rate-limit per provider, for the /usage page.
export interface AgentUsage {
  inputTokens: number; // cumulative input across the session
  outputTokens: number; // cumulative output
  calls: number;
  lastInput: number; // most recent call's input = current context depth
  cacheReadTokens: number; // cumulative — served from cache, priced far below a fresh input token
  cacheWriteTokens: number; // cumulative — written to cache this call, priced slightly above one
}

export interface RateLimitSnapshot {
  provider: string;
  remainingTokens?: number;
  remainingRequests?: number;
}

export class UsageTracker {
  private byAgent = new Map<string, AgentUsage>();
  private rateLimits = new Map<string, RateLimitSnapshot>();

  // `context` is the whole prompt of this call, cached part included. Anthropic's input_tokens is only
  // the uncached tail, so without it lastInput — the context depth the panel shows — reads near zero.
  record(agentId: string, input: number, output: number, cacheRead = 0, cacheWrite = 0, context?: number): void {
    const u = this.byAgent.get(agentId) ?? { inputTokens: 0, outputTokens: 0, calls: 0, lastInput: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    u.inputTokens += input;
    u.outputTokens += output;
    u.calls += 1;
    u.lastInput = context ?? input;
    u.cacheReadTokens += cacheRead;
    u.cacheWriteTokens += cacheWrite;
    this.byAgent.set(agentId, u);
  }

  recordRateLimit(provider: string, rl: { remainingTokens?: number; remainingRequests?: number }): void {
    this.rateLimits.set(provider, { provider, ...rl });
  }

  snapshot(): { agentId: string; usage: AgentUsage }[] {
    return [...this.byAgent.entries()].map(([agentId, usage]) => ({ agentId, usage: { ...usage } }));
  }

  totals(): { inputTokens: number; outputTokens: number; calls: number; cacheReadTokens: number; cacheWriteTokens: number } {
    let inputTokens = 0;
    let outputTokens = 0;
    let calls = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    for (const u of this.byAgent.values()) {
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
      calls += u.calls;
      cacheReadTokens += u.cacheReadTokens;
      cacheWriteTokens += u.cacheWriteTokens;
    }
    return { inputTokens, outputTokens, calls, cacheReadTokens, cacheWriteTokens };
  }

  rateLimits_(): RateLimitSnapshot[] {
    return [...this.rateLimits.values()];
  }

  // Same threshold as the cosmetic low-quota warning in agent.ts — "1 request left" is treated as
  // exhausted for failover-target purposes too.
  nearLimit(provider: string): boolean {
    const rl = this.rateLimits.get(provider);
    return rl?.remainingRequests !== undefined && rl.remainingRequests <= 1;
  }
}
