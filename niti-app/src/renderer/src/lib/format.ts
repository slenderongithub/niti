// Numbers the way people read them.

export function fmtTokens(n: number): string {
  n = Math.round(n);
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 100_000_000) return `${(n / 1_000_000).toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtCost(usd: number, known = true): string {
  if (!known && usd === 0) return "unknown";
  const s = usd >= 100 ? `$${usd.toFixed(0)}` : usd >= 1 ? `$${usd.toFixed(2)}` : usd > 0 ? `$${usd.toFixed(usd < 0.01 ? 4 : 3)}` : "$0.00";
  return known ? s : `${s}+`;
}

export function fmtAgo(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 45_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.round(d / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function shortPath(p: string, home?: string): string {
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
