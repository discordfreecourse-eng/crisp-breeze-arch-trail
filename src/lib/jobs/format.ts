export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${bytes} B`;
  if (abs < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (abs < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatRate(filesPerSec: number): string {
  if (!Number.isFinite(filesPerSec) || filesPerSec <= 0) return "0.00/s";
  if (filesPerSec < 0.01) return `${filesPerSec.toFixed(3)}/s`;
  return `${filesPerSec.toFixed(2)}/s`;
}

export function formatGbPerHour(gb: number): string {
  if (!Number.isFinite(gb) || gb <= 0) return "0.00 GB/h";
  return `${gb.toFixed(2)} GB/h`;
}

export function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.ceil(seconds % 60)}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function mimeLabel(mime: string, kind: "file" | "folder"): string {
  if (kind === "folder" || mime === "application/vnd.google-apps.folder") {
    return "Folder";
  }
  const map: Record<string, string> = {
    "application/vnd.google-apps.document": "Doc",
    "application/vnd.google-apps.spreadsheet": "Sheet",
    "application/vnd.google-apps.presentation": "Slides",
    "application/vnd.google-apps.form": "Form",
    "application/vnd.google-apps.drawing": "Drawing",
    "application/vnd.google-apps.shortcut": "Shortcut",
    "application/pdf": "PDF",
    "application/zip": "Zip",
    "video/mp4": "Video",
    "image/jpeg": "Image",
    "image/png": "Image",
  };
  if (map[mime]) return map[mime];
  if (mime.startsWith("image/")) return "Image";
  if (mime.startsWith("video/")) return "Video";
  if (mime.startsWith("audio/")) return "Audio";
  if (mime.startsWith("text/")) return "Text";
  const tail = mime.split("/").pop() ?? "File";
  return tail.slice(0, 12);
}
