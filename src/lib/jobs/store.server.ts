import { getSql } from "@/lib/db";
import {
  dailyBudgetBytes,
  defaultConcurrency,
  destFolderName,
} from "@/lib/google/env.server";
import type { ParsedDriveLink } from "@/lib/google/links";
import { newId } from "./ids";
import type {
  ExtractedLink,
  JobLog,
  JobProgress,
  JobStatus,
  JobSummary,
  SourceItem,
} from "./types";

type JobRow = {
  id: string;
  status: JobStatus;
  source_filename: string | null;
  dest_folder_name: string;
  dest_folder_id: string | null;
  concurrency: number;
  daily_budget_bytes: number;
  created_at: string | Date | null;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  error: string | null;
};

type ItemRow = {
  id: string;
  drive_id: string;
  parent_drive_id: string | null;
  name: string;
  mime_type: string;
  kind: "file" | "folder";
  size_bytes: number | null;
  file_count: number;
  total_size_bytes: number;
  selected: boolean;
  path: string;
  web_view_link: string | null;
};

type LinkRow = {
  url: string;
  drive_id: string;
  kind_hint: "file" | "folder" | "unknown";
};

type LogRow = {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
  created_at: string | Date;
};

type QueueAgg = {
  files_total: number;
  files_copied: number;
  files_failed: number;
  files_pending: number;
  files_copying: number;
  files_skipped: number;
  retries: number;
  bytes_copied: number;
  bytes_pending: number;
  bytes_failed: number;
};

export type QueueRow = {
  id: string;
  job_id: string;
  source_file_id: string;
  source_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  dest_parent_path: string;
  dest_folder_id: string | null;
  dest_file_id: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
};

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.toISOString();
}

function mapJob(row: JobRow): JobSummary {
  return {
    id: row.id,
    status: row.status,
    sourceFilename: row.source_filename,
    destFolderName: row.dest_folder_name,
    destFolderId: row.dest_folder_id,
    concurrency: row.concurrency,
    dailyBudgetBytes: Number(row.daily_budget_bytes),
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    error: row.error,
  };
}

function mapItem(row: ItemRow): SourceItem {
  return {
    id: row.id,
    driveId: row.drive_id,
    parentDriveId: row.parent_drive_id,
    name: row.name,
    mimeType: row.mime_type,
    kind: row.kind,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    fileCount: Number(row.file_count),
    totalSizeBytes: Number(row.total_size_bytes),
    selected: Boolean(row.selected),
    path: row.path,
    webViewLink: row.web_view_link,
  };
}

export async function getLatestJob(): Promise<JobSummary | null> {
  const sql = await getSql();
  const rows = await sql<JobRow>`select * from jobs order by created_at desc limit 1`;
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function getJobById(id: string): Promise<JobSummary | null> {
  const sql = await getSql();
  const rows = await sql<JobRow>`select * from jobs where id = ${id}`;
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function getActiveWorkJob(): Promise<JobSummary | null> {
  const sql = await getSql();
  const rows = await sql<JobRow>`
    select * from jobs
    where status in ('resolving', 'running')
    order by created_at desc
    limit 1
  `;
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function assertNoActiveWork(): Promise<void> {
  const job = await getActiveWorkJob();
  if (job) {
    throw new Error(
      job.status === "resolving"
        ? "Still resolving Drive items. Wait before loading new links."
        : "A copy is already running. Pause or wait before loading new links.",
    );
  }
}

export async function createJobFromLinks(opts: {
  filename: string | null;
  links: ParsedDriveLink[];
}): Promise<JobSummary> {
  const sql = await getSql();
  const id = newId();
  const dest = destFolderName();
  const concurrency = defaultConcurrency();
  const budget = dailyBudgetBytes();
  await sql`
    insert into jobs (id, status, source_filename, dest_folder_name, concurrency, daily_budget_bytes)
    values (${id}, 'draft', ${opts.filename}, ${dest}, ${concurrency}, ${budget})
  `;
  for (const link of opts.links) {
    await sql`
      insert into extracted_links (id, job_id, url, drive_id, kind_hint)
      values (${newId()}, ${id}, ${link.url}, ${link.driveId}, ${link.kindHint})
      on conflict (job_id, drive_id) do nothing
    `;
  }
  await addLog(id, "info", `Extracted ${opts.links.length} Drive link(s) from ${opts.filename ?? "pasted text"}.`);
  return (await getJobById(id))!;
}

export async function listLinks(jobId: string): Promise<ExtractedLink[]> {
  const sql = await getSql();
  const rows = await sql<LinkRow>`
    select url, drive_id, kind_hint from extracted_links where job_id = ${jobId} order by url
  `;
  return rows.map((r) => ({
    url: r.url,
    driveId: r.drive_id,
    kindHint: r.kind_hint,
  }));
}

export async function listItems(jobId: string): Promise<SourceItem[]> {
  const sql = await getSql();
  const rows = await sql<ItemRow>`
    select * from source_items where job_id = ${jobId} order by kind desc, name
  `;
  return rows.map(mapItem);
}

export async function upsertSourceItem(item: {
  jobId: string;
  driveId: string;
  parentDriveId: string | null;
  name: string;
  mimeType: string;
  kind: "file" | "folder";
  sizeBytes: number | null;
  path: string;
  webViewLink: string | null;
}): Promise<void> {
  const sql = await getSql();
  await sql`
    insert into source_items (
      id, job_id, drive_id, parent_drive_id, name, mime_type, kind,
      size_bytes, file_count, total_size_bytes, selected, path, web_view_link
    )
    values (
      ${newId()}, ${item.jobId}, ${item.driveId}, ${item.parentDriveId}, ${item.name},
      ${item.mimeType}, ${item.kind}, ${item.sizeBytes}, ${item.kind === "file" ? 1 : 0},
      ${item.sizeBytes ?? 0}, true, ${item.path}, ${item.webViewLink}
    )
    on conflict (job_id, drive_id) do update set
      parent_drive_id = excluded.parent_drive_id,
      name = excluded.name,
      mime_type = excluded.mime_type,
      kind = excluded.kind,
      size_bytes = excluded.size_bytes,
      path = excluded.path,
      web_view_link = excluded.web_view_link
  `;
}

export async function recomputeFolderStats(jobId: string): Promise<void> {
  const items = await listItems(jobId);
  const byParent = new Map<string | null, SourceItem[]>();
  for (const item of items) {
    const key = item.parentDriveId;
    const list = byParent.get(key) ?? [];
    list.push(item);
    byParent.set(key, list);
  }
  const memo = new Map<string, { files: number; bytes: number }>();
  const walk = (id: string): { files: number; bytes: number } => {
    const cached = memo.get(id);
    if (cached) return cached;
    const node = items.find((i) => i.driveId === id);
    if (!node) return { files: 0, bytes: 0 };
    if (node.kind === "file") {
      const value = { files: 1, bytes: node.sizeBytes ?? 0 };
      memo.set(id, value);
      return value;
    }
    const children = byParent.get(id) ?? [];
    let files = 0;
    let bytes = 0;
    for (const child of children) {
      const sub = walk(child.driveId);
      files += sub.files;
      bytes += sub.bytes;
    }
    const value = { files, bytes };
    memo.set(id, value);
    return value;
  };
  const sql = await getSql();
  for (const item of items) {
    if (item.kind !== "folder") continue;
    const stats = walk(item.driveId);
    await sql`
      update source_items
      set file_count = ${stats.files}, total_size_bytes = ${stats.bytes}
      where job_id = ${jobId} and drive_id = ${item.driveId}
    `;
  }
}

export async function setJobStatus(
  jobId: string,
  status: JobStatus,
  extra?: { error?: string | null; destFolderId?: string | null },
): Promise<void> {
  const sql = await getSql();
  if (status === "running") {
    await sql`
      update jobs
      set status = ${status},
          started_at = coalesce(started_at, now()),
          error = ${extra?.error ?? null},
          dest_folder_id = coalesce(${extra?.destFolderId ?? null}, dest_folder_id)
      where id = ${jobId}
    `;
    return;
  }
  if (status === "completed" || status === "failed") {
    await sql`
      update jobs
      set status = ${status},
          completed_at = now(),
          error = ${extra?.error ?? null}
      where id = ${jobId}
    `;
    return;
  }
  await sql`
    update jobs
    set status = ${status},
        error = ${extra?.error ?? null},
        dest_folder_id = coalesce(${extra?.destFolderId ?? null}, dest_folder_id)
    where id = ${jobId}
  `;
}

export async function updateJobSettings(
  jobId: string,
  opts: { concurrency?: number; destFolderName?: string; dailyBudgetBytes?: number },
): Promise<void> {
  const sql = await getSql();
  if (opts.concurrency != null) {
    const n = Math.min(20, Math.max(1, Math.floor(opts.concurrency)));
    await sql`update jobs set concurrency = ${n} where id = ${jobId}`;
  }
  if (opts.destFolderName) {
    await sql`update jobs set dest_folder_name = ${opts.destFolderName} where id = ${jobId}`;
  }
  if (opts.dailyBudgetBytes != null) {
    await sql`update jobs set daily_budget_bytes = ${opts.dailyBudgetBytes} where id = ${jobId}`;
  }
}

export async function setItemSelected(
  jobId: string,
  driveId: string,
  selected: boolean,
  recursive: boolean,
): Promise<void> {
  const sql = await getSql();
  await sql`
    update source_items set selected = ${selected}
    where job_id = ${jobId} and drive_id = ${driveId}
  `;
  if (!recursive) return;
  const items = await listItems(jobId);
  const ids = new Set<string>([driveId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (item.parentDriveId && ids.has(item.parentDriveId) && !ids.has(item.driveId)) {
        ids.add(item.driveId);
        grew = true;
      }
    }
  }
  for (const id of ids) {
    await sql`
      update source_items set selected = ${selected}
      where job_id = ${jobId} and drive_id = ${id}
    `;
  }
}

export async function setAllSelected(jobId: string, selected: boolean): Promise<void> {
  const sql = await getSql();
  await sql`update source_items set selected = ${selected} where job_id = ${jobId}`;
}

export async function deleteItem(jobId: string, driveId: string): Promise<void> {
  const items = await listItems(jobId);
  const ids = new Set<string>([driveId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (item.parentDriveId && ids.has(item.parentDriveId) && !ids.has(item.driveId)) {
        ids.add(item.driveId);
        grew = true;
      }
    }
  }
  const sql = await getSql();
  for (const id of ids) {
    await sql`delete from source_items where job_id = ${jobId} and drive_id = ${id}`;
  }
}

export async function selectedStats(jobId: string): Promise<{
  selectedCount: number;
  selectedBytes: number;
  selectedFiles: number;
}> {
  const items = await listItems(jobId);
  const selected = items.filter((i) => i.selected);
  const files = selected.filter((i) => i.kind === "file");
  const selectedFiles = files.length;
  const selectedBytes = files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
  return {
    selectedCount: selected.length,
    selectedBytes,
    selectedFiles,
  };
}

export async function addLog(
  jobId: string,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  const sql = await getSql();
  await sql`
    insert into job_logs (job_id, level, message)
    values (${jobId}, ${level}, ${message})
  `;
}

export async function listLogs(jobId: string, limit = 40): Promise<JobLog[]> {
  const sql = await getSql();
  const rows = await sql<LogRow>`
    select id, level, message, created_at
    from job_logs
    where job_id = ${jobId}
    order by id desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    level: r.level,
    message: r.message,
    createdAt: iso(r.created_at) ?? "",
  }));
}

export async function listRecentCopies(
  jobId: string,
  limit = 16,
): Promise<
  Array<{
    sourceName: string;
    destFileId: string | null;
    status: string;
    sizeBytes: number | null;
  }>
> {
  const sql = await getSql();
  const rows = await sql<{
    source_name: string;
    dest_file_id: string | null;
    status: string;
    size_bytes: number | null;
  }>`
    select source_name, dest_file_id, status, size_bytes
    from copy_queue
    where job_id = ${jobId} and status in ('copied', 'failed', 'copying')
    order by copied_at desc nulls last, id desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    sourceName: r.source_name,
    destFileId: r.dest_file_id,
    status: r.status,
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
  }));
}

export async function getProgress(job: JobSummary): Promise<JobProgress> {
  const sql = await getSql();
  const agg = (
    await sql<QueueAgg>`
      select
        count(*)::int as files_total,
        count(*) filter (where status = 'copied')::int as files_copied,
        count(*) filter (where status = 'failed')::int as files_failed,
        count(*) filter (where status = 'pending')::int as files_pending,
        count(*) filter (where status = 'copying')::int as files_copying,
        count(*) filter (where status = 'skipped')::int as files_skipped,
        coalesce(sum(greatest(attempts - 1, 0)), 0)::int as retries,
        coalesce(sum(size_bytes) filter (where status = 'copied'), 0)::bigint as bytes_copied,
        coalesce(sum(size_bytes) filter (where status in ('pending', 'copying')), 0)::bigint as bytes_pending,
        coalesce(sum(size_bytes) filter (where status = 'failed'), 0)::bigint as bytes_failed
      from copy_queue
      where job_id = ${job.id}
    `
  )[0];

  const windowRows = await sql<{ bytes: number; files: number }>`
    select
      coalesce(sum(bytes), 0)::bigint as bytes,
      count(*)::int as files
    from copy_events
    where occurred_at > now() - interval '1 hour'
  `;
  const dayRows = await sql<{ bytes: number }>`
    select coalesce(sum(bytes), 0)::bigint as bytes
    from copy_events
    where occurred_at > now() - interval '24 hours'
  `;
  const recentRows = await sql<{ files: number; elapsed: number }>`
    select
      count(*)::int as files,
      extract(epoch from (now() - min(occurred_at)))::int as elapsed
    from copy_events
    where occurred_at > now() - interval '5 minutes'
  `;

  const bytesCopied = Number(agg?.bytes_copied ?? 0);
  const bytesPending = Number(agg?.bytes_pending ?? 0);
  const hourBytes = Number(windowRows[0]?.bytes ?? 0);
  const hourFiles = Number(windowRows[0]?.files ?? 0);
  const recentFiles = Number(recentRows[0]?.files ?? 0);
  const recentElapsed = Math.max(1, Number(recentRows[0]?.elapsed ?? 0));

  const started = job.startedAt ? Date.parse(job.startedAt) : NaN;
  const elapsedSec = Number.isFinite(started)
    ? Math.max(1, (Date.now() - started) / 1000)
    : 0;
  const overallFilesPerSec =
    elapsedSec > 0 ? Number(agg?.files_copied ?? 0) / elapsedSec : 0;
  const recentFilesPerSec = recentFiles > 0 ? recentFiles / recentElapsed : 0;
  const filesPerSec = Math.max(overallFilesPerSec, recentFilesPerSec);
  const gbPerHour = hourBytes > 0 ? hourBytes / 1024 ** 3 : bytesCopied / 1024 ** 3 / (elapsedSec / 3600 || 1);
  const remainingFiles = Number(agg?.files_pending ?? 0) + Number(agg?.files_copying ?? 0);

  let etaSeconds: number | null = null;
  if (job.status === "running" || job.status === "paused") {
    const byFiles = filesPerSec > 0 ? remainingFiles / filesPerSec : null;
    const byBytes =
      gbPerHour > 0 && bytesPending > 0
        ? bytesPending / ((gbPerHour * 1024 ** 3) / 3600)
        : null;
    const eta = byFiles ?? byBytes;
    etaSeconds = eta == null ? null : Math.max(0, eta);
  }

  void hourFiles;

  return {
    filesTotal: Number(agg?.files_total ?? 0),
    filesCopied: Number(agg?.files_copied ?? 0),
    filesFailed: Number(agg?.files_failed ?? 0),
    filesPending: Number(agg?.files_pending ?? 0),
    filesCopying: Number(agg?.files_copying ?? 0),
    filesSkipped: Number(agg?.files_skipped ?? 0),
    retries: Number(agg?.retries ?? 0),
    bytesCopied,
    bytesPending,
    bytesFailed: Number(agg?.bytes_failed ?? 0),
    bytesCopiedWindow24h: Number(dayRows[0]?.bytes ?? 0),
    filesPerSec,
    gbPerHour: Number.isFinite(gbPerHour) ? gbPerHour : 0,
    etaSeconds,
  };
}

export async function alreadyCopiedIds(sourceIds: string[]): Promise<Set<string>> {
  if (sourceIds.length === 0) return new Set();
  const sql = await getSql();
  const found = new Set<string>();
  for (const id of sourceIds) {
    const rows = await sql<{ source_file_id: string }>`
      select source_file_id from copy_queue
      where source_file_id = ${id} and dest_file_id is not null
      limit 1
    `;
    if (rows[0]) found.add(id);
  }
  return found;
}

export async function enqueueSelected(job: JobSummary): Promise<{
  queued: number;
  skippedDup: number;
}> {
  const items = await listItems(job.id);
  const selectedFiles = items.filter((i) => i.selected && i.kind === "file");
  const already = await alreadyCopiedIds(selectedFiles.map((f) => f.driveId));
  const sql = await getSql();
  let queued = 0;
  let skippedDup = 0;
  for (const file of selectedFiles) {
    if (already.has(file.driveId)) {
      skippedDup += 1;
      continue;
    }
    const parent = items.find((i) => i.driveId === file.parentDriveId);
    const destParentPath = parent
      ? parent.path
        ? parent.path
        : parent.name
      : "";
    try {
      await sql`
        insert into copy_queue (
          id, job_id, source_file_id, source_name, mime_type, size_bytes,
          dest_parent_path, status
        )
        values (
          ${newId()}, ${job.id}, ${file.driveId}, ${file.name}, ${file.mimeType},
          ${file.sizeBytes}, ${destParentPath}, 'pending'
        )
      `;
      queued += 1;
    } catch {
      skippedDup += 1;
    }
  }
  return { queued, skippedDup };
}

export async function recoverStaleClaims(): Promise<void> {
  const sql = await getSql();
  await sql`
    update copy_queue
    set status = 'pending', claimed_at = null, claimed_by = null
    where status = 'copying'
      and claimed_at is not null
      and claimed_at < now() - interval '10 minutes'
  `;
}

export async function claimNext(jobId: string, workerId: string): Promise<QueueRow | null> {
  const sql = await getSql();
  try {
    const claimed = await sql<QueueRow>`
      update copy_queue
      set status = 'copying',
          claimed_at = now(),
          claimed_by = ${workerId},
          attempts = attempts + 1
      where id = (
        select id from copy_queue
        where job_id = ${jobId}
          and status = 'pending'
          and (next_retry_at is null or next_retry_at <= now())
        order by id
        for update skip locked
        limit 1
      )
      returning *
    `;
    if (claimed[0]) return claimed[0];
  } catch {
    // PGLite may not support FOR UPDATE SKIP LOCKED.
  }

  const next = await sql<QueueRow>`
    select * from copy_queue
    where job_id = ${jobId}
      and status = 'pending'
      and (next_retry_at is null or next_retry_at <= now())
    order by id
    limit 1
  `;
  if (!next[0]) return null;
  const updated = await sql<QueueRow>`
    update copy_queue
    set status = 'copying',
        claimed_at = now(),
        claimed_by = ${workerId},
        attempts = attempts + 1
    where id = ${next[0].id} and status = 'pending'
    returning *
  `;
  return updated[0] ?? null;
}

export async function markCopied(
  id: string,
  destFileId: string,
  destFolderId: string,
  bytes: number,
  jobId: string,
): Promise<void> {
  const sql = await getSql();
  await sql`
    update copy_queue
    set status = 'copied',
        dest_file_id = ${destFileId},
        dest_folder_id = ${destFolderId},
        copied_at = now(),
        last_error = null
    where id = ${id}
  `;
  await sql`
    insert into copy_events (job_id, bytes) values (${jobId}, ${bytes})
  `;
}

export async function markFailed(
  id: string,
  error: string,
  retryAt: string | null,
  giveUp: boolean,
): Promise<void> {
  const sql = await getSql();
  if (giveUp) {
    await sql`
      update copy_queue
      set status = 'failed', last_error = ${error}, claimed_at = null, claimed_by = null
      where id = ${id}
    `;
    return;
  }
  await sql`
    update copy_queue
    set status = 'pending',
        last_error = ${error},
        next_retry_at = ${retryAt},
        claimed_at = null,
        claimed_by = null
    where id = ${id}
  `;
}

export async function bytesCopiedLast24h(): Promise<number> {
  const sql = await getSql();
  const rows = await sql<{ bytes: number }>`
    select coalesce(sum(bytes), 0)::bigint as bytes
    from copy_events
    where occurred_at > now() - interval '24 hours'
  `;
  return Number(rows[0]?.bytes ?? 0);
}

export async function oldestEventAgeMs(): Promise<number | null> {
  const sql = await getSql();
  const rows = await sql<{ occurred_at: string | Date }>`
    select occurred_at from copy_events
    where occurred_at > now() - interval '24 hours'
    order by occurred_at asc
    limit 1
  `;
  if (!rows[0]) return null;
  const t = new Date(rows[0].occurred_at).getTime();
  return Date.now() - t;
}

export async function getDestFolder(
  jobId: string,
  relativePath: string,
): Promise<string | null> {
  const sql = await getSql();
  const rows = await sql<{ drive_id: string }>`
    select drive_id from dest_folders
    where job_id = ${jobId} and relative_path = ${relativePath}
  `;
  return rows[0]?.drive_id ?? null;
}

export async function saveDestFolder(
  jobId: string,
  relativePath: string,
  driveId: string,
): Promise<void> {
  const sql = await getSql();
  await sql`
    insert into dest_folders (job_id, relative_path, drive_id)
    values (${jobId}, ${relativePath}, ${driveId})
    on conflict (job_id, relative_path) do update set drive_id = excluded.drive_id
  `;
}

export async function pendingOrCopyingCount(jobId: string): Promise<number> {
  const sql = await getSql();
  const rows = await sql<{ n: number }>`
    select count(*)::int as n from copy_queue
    where job_id = ${jobId} and status in ('pending', 'copying')
  `;
  return Number(rows[0]?.n ?? 0);
}

export async function tryCompleteJob(jobId: string): Promise<boolean> {
  const remaining = await pendingOrCopyingCount(jobId);
  if (remaining > 0) return false;
  const sql = await getSql();
  const updated = await sql<{ id: string }>`
    update jobs
    set status = 'completed', completed_at = now()
    where id = ${jobId} and status = 'running'
    returning id
  `;
  return Boolean(updated[0]);
}

export async function pauseRemaining(jobId: string): Promise<void> {
  await setJobStatus(jobId, "paused");
}

export async function resumeJob(jobId: string): Promise<void> {
  const sql = await getSql();
  await sql`
    update copy_queue
    set status = 'pending', claimed_at = null, claimed_by = null
    where job_id = ${jobId} and status = 'copying'
  `;
  await setJobStatus(jobId, "running");
}

export async function cancelRemaining(jobId: string): Promise<void> {
  const sql = await getSql();
  await sql`
    update copy_queue
    set status = 'cancelled', claimed_at = null, claimed_by = null
    where job_id = ${jobId} and status in ('pending', 'copying')
  `;
  await setJobStatus(jobId, "failed", { error: "Cancelled" });
}

export async function saveSetting(key: string, value: string): Promise<void> {
  const sql = await getSql();
  await sql`
    insert into settings (key, value) values (${key}, ${value})
    on conflict (key) do update set value = excluded.value
  `;
}

export async function readSetting(key: string): Promise<string | null> {
  const sql = await getSql();
  const rows = await sql<{ value: string }>`
    select value from settings where key = ${key}
  `;
  return rows[0]?.value ?? null;
}
