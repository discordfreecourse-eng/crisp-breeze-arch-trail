import {
  getFile,
  listChildren,
  resolveShortcut,
  type DriveFile,
} from "@/lib/google/drive.server";
import { addLog, listLinks, recomputeFolderStats, setJobStatus, upsertSourceItem } from "./store.server";
import type { JobSummary } from "./types";

const FOLDER_MIME = "application/vnd.google-apps.folder";

function fileSize(file: DriveFile): number | null {
  if (file.size == null || file.size === "") return null;
  const n = Number(file.size);
  return Number.isFinite(n) ? n : null;
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function walkFolder(
  jobId: string,
  folder: DriveFile,
  parentDriveId: string | null,
  path: string,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(folder.id)) return;
  seen.add(folder.id);
  await upsertSourceItem({
    jobId,
    driveId: folder.id,
    parentDriveId,
    name: folder.name,
    mimeType: folder.mimeType,
    kind: "folder",
    sizeBytes: null,
    path,
    webViewLink: folder.webViewLink ?? null,
  });
  const children = await listChildren(folder.id);
  for (const child of children) {
    const resolved = await resolveShortcut(child);
    const childPath = joinPath(path, resolved.name);
    if (resolved.mimeType === FOLDER_MIME) {
      await walkFolder(jobId, resolved, folder.id, childPath, seen);
    } else {
      if (seen.has(resolved.id)) continue;
      seen.add(resolved.id);
      await upsertSourceItem({
        jobId,
        driveId: resolved.id,
        parentDriveId: folder.id,
        name: resolved.name,
        mimeType: resolved.mimeType,
        kind: "file",
        sizeBytes: fileSize(resolved),
        path: childPath,
        webViewLink: resolved.webViewLink ?? null,
      });
    }
  }
}

export async function resolveJob(job: JobSummary): Promise<void> {
  const links = await listLinks(job.id);
  await addLog(job.id, "info", `Resolving ${links.length} Drive item(s)…`);
  const seen = new Set<string>();
  let ok = 0;
  let failed = 0;

  await mapLimit(links, 4, async (link) => {
    try {
      const raw = await getFile(link.driveId);
      const file = await resolveShortcut(raw);
      if (file.mimeType === FOLDER_MIME) {
        await walkFolder(job.id, file, null, file.name, seen);
      } else {
        if (seen.has(file.id)) return;
        seen.add(file.id);
        await upsertSourceItem({
          jobId: job.id,
          driveId: file.id,
          parentDriveId: null,
          name: file.name,
          mimeType: file.mimeType,
          kind: "file",
          sizeBytes: fileSize(file),
          path: file.name,
          webViewLink: file.webViewLink ?? null,
        });
      }
      ok += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await addLog(job.id, "warn", `Could not resolve ${link.driveId}: ${message}`);
    }
  });

  await recomputeFolderStats(job.id);
  if (ok === 0 && failed > 0) {
    await setJobStatus(job.id, "failed", { error: "Could not resolve any Drive items." });
    await addLog(job.id, "error", "Resolve failed — check Drive access and reconnect if needed.");
    return;
  }
  await setJobStatus(job.id, "ready");
  await addLog(
    job.id,
    "info",
    `Resolved ${ok} root item(s)${failed ? `, ${failed} failed` : ""}. Review and start copy.`,
  );
}
