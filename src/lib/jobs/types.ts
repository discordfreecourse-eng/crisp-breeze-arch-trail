export type JobStatus =
  | "draft"
  | "resolving"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type QueueStatus =
  | "pending"
  | "copying"
  | "copied"
  | "skipped"
  | "failed"
  | "cancelled";

export type SourceKind = "file" | "folder";

export type ExtractedLink = {
  url: string;
  driveId: string;
  kindHint: "file" | "folder" | "unknown";
};

export type SourceItem = {
  id: string;
  driveId: string;
  parentDriveId: string | null;
  name: string;
  mimeType: string;
  kind: SourceKind;
  sizeBytes: number | null;
  fileCount: number;
  totalSizeBytes: number;
  selected: boolean;
  path: string;
  webViewLink: string | null;
};

export type JobSummary = {
  id: string;
  status: JobStatus;
  sourceFilename: string | null;
  destFolderName: string;
  destFolderId: string | null;
  concurrency: number;
  dailyBudgetBytes: number;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

export type JobProgress = {
  filesTotal: number;
  filesCopied: number;
  filesFailed: number;
  filesPending: number;
  filesCopying: number;
  filesSkipped: number;
  retries: number;
  bytesCopied: number;
  bytesPending: number;
  bytesFailed: number;
  bytesCopiedWindow24h: number;
  filesPerSec: number;
  gbPerHour: number;
  etaSeconds: number | null;
};

export type JobLog = {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
};

export type GoogleStatus = {
  hasClientId: boolean;
  hasClientSecret: boolean;
  connected: boolean;
  email: string | null;
  redirectUri: string;
  publicOrigin: string;
};

export type RecentCopy = {
  sourceName: string;
  destFileId: string | null;
  status: string;
  sizeBytes: number | null;
};

export type Overview = {
  google: GoogleStatus;
  job: JobSummary | null;
  links: ExtractedLink[];
  items: SourceItem[];
  progress: JobProgress | null;
  logs: JobLog[];
  recentCopies: RecentCopy[];
  selectedCount: number;
  selectedBytes: number;
  selectedFiles: number;
  destFolderName: string;
  concurrency: number;
  dailyBudgetGb: number;
  longRunning: boolean;
};
