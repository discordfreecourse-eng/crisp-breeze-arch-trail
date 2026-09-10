import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Overview } from "@/lib/jobs/types";

export const getOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<Overview> => {
    const { ensureWorkerStarted, tickWorker } = await import("@/lib/jobs/worker.server");
    ensureWorkerStarted();
    const { isLongRunningProcess } = await import("@/lib/google/env.server");
    if (!isLongRunningProcess()) {
      await tickWorker();
    }

    const { getRequest } = await import("@tanstack/react-start/server");
    const {
      googleClientId,
      googleClientSecret,
      googleRedirectUri,
      publicOriginFromRequest,
      destFolderName,
      defaultConcurrency,
      dailyBudgetBytes,
    } = await import("@/lib/google/env.server");
    const { getConnectedAccount } = await import("@/lib/google/oauth.server");
    const {
      getLatestJob,
      listLinks,
      listItems,
      listLogs,
      listRecentCopies,
      getProgress,
      selectedStats,
    } = await import("@/lib/jobs/store.server");

    const request = getRequest();
    const account = await getConnectedAccount();
    const job = await getLatestJob();
    const links = job ? await listLinks(job.id) : [];
    const items = job ? await listItems(job.id) : [];
    const logs = job ? await listLogs(job.id) : [];
    const recentCopies = job ? await listRecentCopies(job.id) : [];
    const progress = job ? await getProgress(job) : null;
    const stats = job
      ? await selectedStats(job.id)
      : { selectedCount: 0, selectedBytes: 0, selectedFiles: 0 };

    return {
      google: {
        hasClientId: Boolean(googleClientId()),
        hasClientSecret: Boolean(googleClientSecret()),
        connected: account.connected,
        email: account.email,
        redirectUri: googleRedirectUri(request),
        publicOrigin: publicOriginFromRequest(request),
      },
      job,
      links,
      items,
      progress,
      logs,
      recentCopies,
      selectedCount: stats.selectedCount,
      selectedBytes: stats.selectedBytes,
      selectedFiles: stats.selectedFiles,
      destFolderName: job?.destFolderName ?? destFolderName(),
      concurrency: job?.concurrency ?? defaultConcurrency(),
      dailyBudgetGb: (job?.dailyBudgetBytes ?? dailyBudgetBytes()) / 1024 ** 3,
      longRunning: isLongRunningProcess(),
    };
  },
);

export const startGoogleConnect = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ url: string }> => {
    const { buildAuthUrl } = await import("@/lib/google/oauth.server");
    return { url: await buildAuthUrl() };
  },
);

export const disconnectGoogleFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: true }> => {
    const { disconnectGoogle } = await import("@/lib/google/oauth.server");
    await disconnectGoogle();
    return { ok: true };
  },
);

export const ingestLinks = createServerFn({ method: "POST" })
  .validator(z.object({ text: z.string().min(1), filename: z.string().nullable() }))
  .handler(async ({ data }): Promise<{ jobId: string; count: number }> => {
    const { extractDriveLinksFromText } = await import("@/lib/google/links");
    const { createJobFromLinks, assertNoActiveWork } = await import("@/lib/jobs/store.server");
    await assertNoActiveWork();
    const links = extractDriveLinksFromText(data.text);
    if (links.length === 0) {
      throw new Error("No Google Drive links found.");
    }
    const job = await createJobFromLinks({
      filename: data.filename ?? "pasted-links",
      links,
    });
    return { jobId: job.id, count: links.length };
  },
);

export const startResolve = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: true }> => {
    const { getLatestJob, setJobStatus, addLog } = await import("@/lib/jobs/store.server");
    const { getConnectedAccount } = await import("@/lib/google/oauth.server");
    const { ensureWorkerStarted, tickWorker } = await import("@/lib/jobs/worker.server");
    const account = await getConnectedAccount();
    if (!account.connected) throw new Error("Connect Google Drive first.");
    const job = await getLatestJob();
    if (!job) throw new Error("Upload a PDF or paste Drive links first.");
    if (job.status === "running") throw new Error("A copy is already running.");
    await setJobStatus(job.id, "resolving");
    await addLog(job.id, "info", "Resolving folders and files from Drive…");
    ensureWorkerStarted();
    void tickWorker();
    return { ok: true };
  },
);

export const toggleItemFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      driveId: z.string(),
      selected: z.boolean(),
    }),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { getLatestJob, setItemSelected } = await import("@/lib/jobs/store.server");
    const job = await getLatestJob();
    if (!job) throw new Error("No job.");
    await setItemSelected(job.id, data.driveId, data.selected, true);
    return { ok: true };
  });

export const selectAllFn = createServerFn({ method: "POST" })
  .validator(z.object({ selected: z.boolean() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { getLatestJob, setAllSelected } = await import("@/lib/jobs/store.server");
    const job = await getLatestJob();
    if (!job) throw new Error("No job.");
    await setAllSelected(job.id, data.selected);
    return { ok: true };
  });

export const deleteItemFn = createServerFn({ method: "POST" })
  .validator(z.object({ driveId: z.string() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { getLatestJob, deleteItem } = await import("@/lib/jobs/store.server");
    const job = await getLatestJob();
    if (!job) throw new Error("No job.");
    await deleteItem(job.id, data.driveId);
    return { ok: true };
  });

export const updateSettingsFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      concurrency: z.number().min(1).max(20).optional(),
      destFolderName: z.string().min(1).max(64).optional(),
      dailyBudgetGb: z.number().min(1).max(5000).optional(),
    }),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { getLatestJob, updateJobSettings } = await import("@/lib/jobs/store.server");
    const job = await getLatestJob();
    if (!job) throw new Error("No job.");
    await updateJobSettings(job.id, {
      concurrency: data.concurrency,
      destFolderName: data.destFolderName
        ? data.destFolderName.replace(/[\\/]+/g, "").trim()
        : undefined,
      dailyBudgetBytes:
        data.dailyBudgetGb != null ? Math.round(data.dailyBudgetGb * 1024 ** 3) : undefined,
    });
    return { ok: true };
  });

export const startCopyFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ queued: number; skippedDup: number }> => {
    const { getConnectedAccount } = await import("@/lib/google/oauth.server");
    const {
      getLatestJob,
      enqueueSelected,
      setJobStatus,
      addLog,
      selectedStats,
    } = await import("@/lib/jobs/store.server");
    const { ensureFolder } = await import("@/lib/google/drive.server");
    const { saveDestFolder } = await import("@/lib/jobs/store.server");
    const { ensureWorkerStarted, tickWorker } = await import("@/lib/jobs/worker.server");

    const account = await getConnectedAccount();
    if (!account.connected) throw new Error("Connect Google Drive first.");
    const job = await getLatestJob();
    if (!job) throw new Error("No job to copy.");
    if (job.status === "running") throw new Error("Copy is already running.");
    if (job.status === "resolving") throw new Error("Still resolving Drive items.");
    const stats = await selectedStats(job.id);
    if (stats.selectedFiles === 0) throw new Error("Select at least one file.");

    const folder = await ensureFolder(job.destFolderName, "root");
    await saveDestFolder(job.id, "", folder.id);
    const { queued, skippedDup } = await enqueueSelected(job);
    if (queued === 0 && skippedDup === 0) {
      throw new Error("Nothing to copy.");
    }
    await setJobStatus(job.id, "running", { destFolderId: folder.id });
    await addLog(
      job.id,
      "info",
      `Started copy: ${queued} file(s) queued${skippedDup ? `, ${skippedDup} already copied` : ""}. Destination /${job.destFolderName}.`,
    );
    ensureWorkerStarted();
    void tickWorker();
    return { queued, skippedDup };
  },
);

export const pauseCopyFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: true }> => {
    const { getLatestJob, pauseRemaining, addLog } = await import("@/lib/jobs/store.server");
    const job = await getLatestJob();
    if (!job) throw new Error("No job.");
    await pauseRemaining(job.id);
    await addLog(job.id, "warn", "Paused. In-flight copies may finish, remaining files wait.");
    return { ok: true };
  },
);

export const resumeCopyFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: true }> => {
    const { getLatestJob, resumeJob, addLog } = await import("@/lib/jobs/store.server");
    const { ensureWorkerStarted, tickWorker } = await import("@/lib/jobs/worker.server");
    const job = await getLatestJob();
    if (!job) throw new Error("No job.");
    await resumeJob(job.id);
    await addLog(job.id, "info", "Resumed copy.");
    ensureWorkerStarted();
    void tickWorker();
    return { ok: true };
  },
);

export const cancelCopyFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: true }> => {
    const { getLatestJob, cancelRemaining, addLog } = await import("@/lib/jobs/store.server");
    const job = await getLatestJob();
    if (!job) throw new Error("No job.");
    await cancelRemaining(job.id);
    await addLog(job.id, "warn", "Cancelled remaining files.");
    return { ok: true };
  },
);
