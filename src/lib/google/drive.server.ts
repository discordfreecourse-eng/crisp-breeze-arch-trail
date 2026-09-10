import { getAccessToken } from "./oauth.server";

export class DriveRetryableError extends Error {
  status: number;
  reason: string;
  retryAfterMs: number | null;
  constructor(status: number, reason: string, message: string, retryAfterMs: number | null) {
    super(message);
    this.name = "DriveRetryableError";
    this.status = status;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

export class DriveFatalError extends Error {
  status: number;
  reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.name = "DriveFatalError";
    this.status = status;
    this.reason = reason;
  }
}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  parents?: string[];
  webViewLink?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
  capabilities?: { canCopy?: boolean };
};

type ErrorBody = {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
    status?: string;
  };
};

const FIELDS =
  "id,name,mimeType,size,parents,webViewLink,shortcutDetails,capabilities(canCopy)";

function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

function isRetryable(status: number, reason: string): boolean {
  if (status === 429 || status >= 500) return true;
  if (status !== 403) return false;
  return [
    "userRateLimitExceeded",
    "rateLimitExceeded",
    "dailyLimitExceeded",
    "sharingRateLimitExceeded",
    "backendError",
  ].includes(reason);
}

async function driveFetch<T>(
  path: string,
  init: RequestInit = {},
  retryAuth = true,
): Promise<T> {
  const token = await getAccessToken({ forceRefresh: !retryAuth });
  const url = path.startsWith("http")
    ? path
    : `https://www.googleapis.com/drive/v3${path}`;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 && retryAuth) {
    return driveFetch<T>(path, init, false);
  }
  if (!res.ok) {
    let body: ErrorBody = {};
    try {
      body = (await res.json()) as ErrorBody;
    } catch {
      body = { error: { message: await res.text().catch(() => res.statusText) } };
    }
    const reason = body.error?.errors?.[0]?.reason || body.error?.status || "unknown";
    const message = body.error?.message || `Google Drive error ${res.status}`;
    if (isRetryable(res.status, reason)) {
      throw new DriveRetryableError(res.status, reason, message, parseRetryAfter(res));
    }
    throw new DriveFatalError(res.status, reason, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function getFile(id: string): Promise<DriveFile> {
  const q = new URLSearchParams({
    fields: FIELDS,
    supportsAllDrives: "true",
  });
  return driveFetch<DriveFile>(`/files/${encodeURIComponent(id)}?${q.toString()}`);
}

export async function listChildren(folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields: `nextPageToken,files(${FIELDS})`,
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "allDrives",
    });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await driveFetch<{ files?: DriveFile[]; nextPageToken?: string }>(
      `/files?${q.toString()}`,
    );
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

export async function findChildFolder(
  parentId: string,
  name: string,
): Promise<DriveFile | null> {
  const escaped = name.replace(/'/g, "\\'");
  const q = new URLSearchParams({
    q: `'${parentId.replace(/'/g, "\\'")}' in parents and name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: `files(${FIELDS})`,
    pageSize: "1",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const page = await driveFetch<{ files?: DriveFile[] }>(`/files?${q.toString()}`);
  return page.files?.[0] ?? null;
}

export async function createFolder(name: string, parentId: string): Promise<DriveFile> {
  return driveFetch<DriveFile>(
    `/files?supportsAllDrives=true&fields=${encodeURIComponent(FIELDS)}`,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    },
  );
}

export async function ensureFolder(name: string, parentId: string): Promise<DriveFile> {
  const existing = await findChildFolder(parentId, name);
  if (existing) return existing;
  return createFolder(name, parentId);
}

export async function copyFile(
  sourceId: string,
  name: string,
  destParentId: string,
): Promise<DriveFile> {
  const q = new URLSearchParams({
    supportsAllDrives: "true",
    fields: FIELDS,
  });
  return driveFetch<DriveFile>(`/files/${encodeURIComponent(sourceId)}/copy?${q.toString()}`, {
    method: "POST",
    body: JSON.stringify({
      name,
      parents: [destParentId],
    }),
  });
}

export async function resolveShortcut(file: DriveFile): Promise<DriveFile> {
  if (file.mimeType !== "application/vnd.google-apps.shortcut") return file;
  const targetId = file.shortcutDetails?.targetId;
  if (!targetId) return file;
  return getFile(targetId);
}
