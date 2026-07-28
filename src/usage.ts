// Accumulates token usage per agent and the latest rate-limit per provider, for the /usage page.
export interface AgentUsage {
  inputTokens: number; // cumulative input across the session
  outputTokens: number; // cumulative output
  calls: number;
  lastInput: number; // most recent call's input = current context depth
}

export interface RateLimitSnapshot {
  provider: string;
  remainingTokens?: number;
  remainingRequests?: number;
}

export class UsageTracker {
  private byAgent = new Map<string, AgentUsage>();
  private rateLimits = new Map<string, RateLimitSnapshot>();

  record(agentId: string, input: number, output: number): void {
    const u = this.byAgent.get(agentId) ?? { inputTokens: 0, outputTokens: 0, calls: 0, lastInput: 0 };
    u.inputTokens += input;
    u.outputTokens += output;
    u.calls += 1;
    u.lastInput = input;
    this.byAgent.set(agentId, u);
  }

  recordRateLimit(provider: string, rl: { remainingTokens?: number; remainingRequests?: number }): void {
    this.rateLimits.set(provider, { provider, ...rl });
  }

  snapshot(): { agentId: string; usage: AgentUsage }[] {
    return [...this.byAgent.entries()].map(([agentId, usage]) => ({ agentId, usage: { ...usage } }));
  }

  totals(): { inputTokens: number; outputTokens: number; calls: number } {
    let inputTokens = 0;
    let outputTokens = 0;
    let calls = 0;
    for (const u of this.byAgent.values()) {
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
      calls += u.calls;
    }
    return { inputTokens, outputTokens, calls };
  }

  rateLimits_(): RateLimitSnapshot[] {
    return [...this.rateLimits.values()];
  }
}
