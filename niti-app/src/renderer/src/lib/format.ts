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

// The core refuses an unanswered approval on its own at expiresAt (src/approval.ts); this counts down to it.
export function fmtApprovalCountdown(expiresAt: number | undefined, now = Date.now()): string {
  if (!expiresAt) return "";
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `niti will automatically deny this request in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}, to avoid blocking progress on an unattended session`;
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

// Sizes the way Finder shows them (decimal: a "4.9 GB" download is 4.9 GB in Finder too).
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")} ${units[i]}`;
}

// A model's size by parameters: 4022468096 → "4B", 30_500_000_000 → "30.5B", 600M stays "600M".
export function fmtParams(n: number | undefined): string {
  if (!n) return "?";
  if (n < 1e9) return `${Math.round(n / 1e6)}M`;
  const b = n / 1e9;
  return `${b >= 10 ? (Math.round(b * 10) / 10).toString().replace(/\.0$/, "") : b.toFixed(1).replace(/\.0$/, "")}B`;
}

// Downloads and likes: 4991826 → "5M", 1427665 → "1.4M", 566 → "566".
export function fmtCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

// Time left at the current rate, for a download: "4m left", "1h 12m left".
export function fmtEta(remaining: number, bytesPerSec: number): string {
  if (bytesPerSec <= 0 || remaining <= 0) return "";
  const s = Math.round(remaining / bytesPerSec);
  if (s < 60) return `${s}s left`;
  if (s < 3600) return `${Math.round(s / 60)}m left`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m left`;
}
