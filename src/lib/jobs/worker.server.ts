import {
  copyFile,
  DriveRetryableError,
  ensureFolder,
} from "@/lib/google/drive.server";
import { isLongRunningProcess } from "@/lib/google/env.server";
import { resolveJob } from "./resolve.server";
import {
  addLog,
  bytesCopiedLast24h,
  claimNext,
  getActiveWorkJob,
  getDestFolder,
  getJobById,
  markCopied,
  markFailed,
  oldestEventAgeMs,
  recoverStaleClaims,
  saveDestFolder,
  tryCompleteJob,
  type QueueRow,
} from "./store.server";
import type { JobSummary } from "./types";

const MAX_ATTEMPTS = 12;
const MAX_BACKOFF_MS = 60_000;
const BUDGET_POLL_MS = 5_000;
const MAX_SLOTS = 20;

const g = globalThis as typeof globalThis & {
  __rawCopyWorkerStarted?: boolean;
  __rawCopyWorkerRunning?: boolean;
  __rawCopyCooldownUntil?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempts: number, retryAfterMs: number | null): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 5 * 60_000);
  const exp = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1));
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

function setGlobalCooldown(ms: number): void {
  const until = Date.now() + ms;
  g.__rawCopyCooldownUntil = Math.max(g.__rawCopyCooldownUntil ?? 0, until);
}

async function honorGlobalCooldown(): Promise<void> {
  const wait = (g.__rawCopyCooldownUntil ?? 0) - Date.now();
  if (wait > 0) await sleep(Math.min(wait, 60_000));
}

async function waitForBudget(job: JobSummary, nextBytes: number): Promise<boolean> {
  let warned = false;
  while (true) {
    const fresh = await getJobById(job.id);
    if (!fresh || fresh.status !== "running") return false;
    const used = await bytesCopiedLast24h();
    if (used + Math.max(0, nextBytes) <= fresh.dailyBudgetBytes) return true;
    if (!warned) {
      warned = true;
      await addLog(
        job.id,
        "warn",
        `Daily copy budget reached (${(used / 1024 ** 3).toFixed(1)} GB / ${(fresh.dailyBudgetBytes / 1024 ** 3).toFixed(0)} GB). Waiting…`,
      );
    }
    const age = await oldestEventAgeMs();
    const wait = age == null ? BUDGET_POLL_MS : Math.max(BUDGET_POLL_MS, 24 * 3600_000 - age + 1000);
    await sleep(Math.min(wait, 60_000));
  }
}

async function ensureDestPath(job: JobSummary, relativePath: string): Promise<string> {
  const rootId = job.destFolderId;
  if (!rootId) throw new Error("Destination /Raw folder is not ready.");
  if (!relativePath) return rootId;
  const cached = await getDestFolder(job.id, relativePath);
  if (cached) return cached;
  const parts = relativePath.split("/").filter(Boolean);
  let parentId = rootId;
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const existing = await getDestFolder(job.id, acc);
    if (existing) {
      parentId = existing;
      continue;
    }
    const folder = await ensureFolder(part, parentId);
    await saveDestFolder(job.id, acc, folder.id);
    parentId = folder.id;
  }
  return parentId;
}

async function copyOne(job: JobSummary, item: QueueRow): Promise<void> {
  const size = Number(item.size_bytes ?? 0);
  const giveUp = item.attempts >= MAX_ATTEMPTS;
  try {
    await honorGlobalCooldown();
    const destParent = await ensureDestPath(job, item.dest_parent_path);
    const copied = await copyFile(item.source_file_id, item.source_name, destParent);
    await markCopied(item.id, copied.id, destParent, size, job.id);
    await addLog(job.id, "info", `Copied ${item.source_name} → ${copied.id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof DriveRetryableError && !giveUp) {
      const wait = backoffMs(item.attempts, err.retryAfterMs);
      setGlobalCooldown(Math.min(wait, 15_000));
      const retryAt = new Date(Date.now() + wait).toISOString();
      await markFailed(item.id, `${err.reason}: ${message}`, retryAt, false);
      await addLog(
        job.id,
        "warn",
        `Retry ${item.source_name} in ${Math.ceil(wait / 1000)}s (${err.reason})`,
      );
      return;
    }
    await markFailed(item.id, message, null, true);
    await addLog(job.id, "error", `Failed ${item.source_name}: ${message}`);
  }
}

async function runCopy(job: JobSummary): Promise<void> {
  if (!job.destFolderId) {
    const { destFolderName } = await import("@/lib/google/env.server");
    const { saveDestFolder, setJobStatus } = await import("./store.server");
    const folder = await (await import("@/lib/google/drive.server")).ensureFolder(
      job.destFolderName || destFolderName(),
      "root",
    );
    await setJobStatus(job.id, "running", { destFolderId: folder.id });
    await saveDestFolder(job.id, "", folder.id);
    await addLog(job.id, "info", `Destination folder ready: /${job.destFolderName} (${folder.id})`);
    job = (await getJobById(job.id)) ?? job;
  }

  const live = new Map<number, Promise<void>>();
  let stop = false;

  const spawn = (slot: number) => {
    if (live.has(slot)) return;
    const run = (async () => {
      while (!stop) {
        const fresh = await getJobById(job.id);
        if (!fresh || fresh.status !== "running") {
          stop = true;
          return;
        }
        if (slot >= fresh.concurrency) {
          return;
        }
        const item = await claimNext(job.id, `w${slot}`);
        if (!item) {
          const remaining = await (await import("./store.server")).pendingOrCopyingCount(job.id);
          if (remaining === 0) {
            const completed = await tryCompleteJob(job.id);
            if (completed) {
              await addLog(job.id, "info", "Copy finished.");
            }
            stop = true;
            return;
          }
          await sleep(500);
          continue;
        }
        const ok = await waitForBudget(fresh, Number(item.size_bytes ?? 0));
        if (!ok) {
          await markFailed(item.id, "Job paused or stopped", null, false);
          return;
        }
        try {
          await copyOne(fresh, item);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await markFailed(item.id, message, null, true);
          await addLog(job.id, "error", `Worker fault on ${item.source_name}: ${message}`);
        }
      }
    })().finally(() => {
      live.delete(slot);
    });
    live.set(slot, run);
  };

  while (!stop) {
    const fresh = await getJobById(job.id);
    if (!fresh || fresh.status !== "running") break;
    const want = Math.max(1, Math.min(MAX_SLOTS, fresh.concurrency));
    for (let i = 0; i < want; i += 1) spawn(i);
    if (live.size === 0) break;
    await sleep(400);
  }
  await Promise.all([...live.values()]);
}

async function processActiveJob(): Promise<boolean> {
  await recoverStaleClaims();
  const job = await getActiveWorkJob();
  if (!job) return false;
  if (job.status === "resolving") {
    await resolveJob(job);
    return true;
  }
  if (job.status === "running") {
    await runCopy(job);
    return true;
  }
  return false;
}

export async function tickWorker(): Promise<void> {
  if (g.__rawCopyWorkerRunning) return;
  g.__rawCopyWorkerRunning = true;
  try {
    await processActiveJob();
  } catch (err) {
    console.error("[raw-copy] worker tick failed", err);
    const job = await getActiveWorkJob().catch(() => null);
    if (job) {
      const message = err instanceof Error ? err.message : String(err);
      await addLog(job.id, "error", `Worker error: ${message}`).catch(() => undefined);
    }
  } finally {
    g.__rawCopyWorkerRunning = false;
  }
}

export function ensureWorkerStarted(): void {
  if (g.__rawCopyWorkerStarted) return;
  g.__rawCopyWorkerStarted = true;
  if (!isLongRunningProcess()) return;
  const loop = async () => {
    while (true) {
      try {
        await tickWorker();
      } catch (err) {
        console.error("[raw-copy] supervisor", err);
      }
      await sleep(1000);
    }
  };
  void loop();
}
