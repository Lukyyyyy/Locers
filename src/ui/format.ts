import type { Language } from "../state/uiStore";

export function formatBytes(value?: number | null): string {
  if (value == null) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatPercent(value?: number | null): string {
  return value == null ? "-" : `${value.toFixed(1)}%`;
}

export function formatPorts(ports: number[]): string {
  const uniquePorts = Array.from(new Set(ports)).sort((left, right) => left - right);
  return uniquePorts.length ? uniquePorts.join(", ") : "-";
}

export function formatDuration(seconds?: number | null, language: Language = "en"): string {
  if (seconds == null) return "-";
  if (seconds < 60) return language === "zh" ? `${seconds} 秒` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return language === "zh" ? `${minutes} 分钟` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return language === "zh" ? `${hours} 小时` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return language === "zh" ? `${days} 天` : `${days}d`;
}

export function getDisplayUptimeSeconds({
  status,
  uptimeSeconds,
  receivedAt,
  now
}: {
  status: "running" | "stopped" | "error" | "unknown";
  uptimeSeconds?: number | null;
  receivedAt: number;
  now: number;
}): number | null | undefined {
  if (status !== "running" || uptimeSeconds == null) return uptimeSeconds;
  return uptimeSeconds + Math.max(0, Math.floor((now - receivedAt) / 1000));
}

export function formatRelativeTime(input: string, language: Language = "en"): string {
  const delta = Date.now() - new Date(input).getTime();
  if (language === "zh") {
    if (delta < 60_000) return "刚刚";
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
    return `${Math.floor(delta / 86_400_000)} 天前`;
  }
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
