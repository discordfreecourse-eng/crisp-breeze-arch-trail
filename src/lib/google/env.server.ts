import { env } from "@/lib/env.server";
import { getRequest } from "@tanstack/react-start/server";

const DEFAULT_BUDGET_GB = 600;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_DEST = "Raw";

export function googleClientId(): string | undefined {
  return env("GOOGLE_CLIENT_ID");
}

export function googleClientSecret(): string | undefined {
  return env("GOOGLE_CLIENT_SECRET");
}

export function destFolderName(): string {
  return env("DEST_FOLDER_NAME") || DEFAULT_DEST;
}

export function defaultConcurrency(): number {
  const raw = env("COPY_CONCURRENCY");
  const n = raw ? Number(raw) : DEFAULT_CONCURRENCY;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(20, Math.floor(n));
}

export function dailyBudgetBytes(): number {
  const raw = env("COPY_DAILY_BUDGET_GB");
  const gb = raw ? Number(raw) : DEFAULT_BUDGET_GB;
  const safe = Number.isFinite(gb) && gb > 0 ? gb : DEFAULT_BUDGET_GB;
  return Math.round(safe * 1024 ** 3);
}

export function isLongRunningProcess(): boolean {
  // Opt-in: Docker/Northflank set LONG_RUNNING=1 so copies continue
  // after the browser closes. Vercel / vite preview tick on request instead.
  return env("LONG_RUNNING") === "1";
}

export function publicOriginFromRequest(request?: Request | null): string {
  const explicit = env("PUBLIC_BASE_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  const req = request ?? (typeof getRequest === "function" ? getRequest() : null);
  if (!req) return "http://127.0.0.1:8080";
  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    "127.0.0.1:8080";
  const proto =
    req.headers.get("x-forwarded-proto") ||
    (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto.split(",")[0]!.trim()}://${host.split(",")[0]!.trim()}`;
}

export function googleRedirectUri(request?: Request | null): string {
  const explicit = env("GOOGLE_REDIRECT_URI");
  if (explicit) return explicit;
  return `${publicOriginFromRequest(request)}/api/google/callback`;
}

export function requestIsHttps(request?: Request | null): boolean {
  const req = request ?? (typeof getRequest === "function" ? getRequest() : null);
  if (!req) return false;
  const proto = req.headers.get("x-forwarded-proto") || new URL(req.url).protocol;
  return proto.includes("https");
}
