export type ParsedDriveLink = {
  url: string;
  driveId: string;
  kindHint: "file" | "folder" | "unknown";
};

const ID = "([a-zA-Z0-9_-]{10,})";

const PATTERNS: Array<{ re: RegExp; kind: ParsedDriveLink["kindHint"] }> = [
  { re: new RegExp(`drive\\.google\\.com/drive/(?:u/\\d+/)?folders/${ID}`, "i"), kind: "folder" },
  { re: new RegExp(`drive\\.google\\.com/file/d/${ID}`, "i"), kind: "file" },
  { re: new RegExp(`docs\\.google\\.com/(?:document|spreadsheets|presentation|forms|drawings|file)/d/${ID}`, "i"), kind: "file" },
  { re: new RegExp(`drive\\.google\\.com/open\\?[^\\s\"'<>]*id=${ID}`, "i"), kind: "unknown" },
  { re: new RegExp(`drive\\.google\\.com/uc\\?[^\\s\"'<>]*id=${ID}`, "i"), kind: "file" },
  { re: new RegExp(`drive\\.google\\.com/(?:a/[^/]+/)?uc\\?[^\\s\"'<>]*id=${ID}`, "i"), kind: "file" },
];

const LOOSE_URL =
  /https?:\/\/(?:drive|docs)\.google\.com\/[^\s<>"'\\)\]]+/gi;

function decodePdfEscapes(raw: string): string {
  return raw
    .replace(/\\(\d{1,3})/g, (_, oct: string) =>
      String.fromCharCode(parseInt(oct, 8) & 255),
    )
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function stripNulls(input: string): string {
  return input.replace(/\u0000/g, "");
}

function canonicalizeUrl(url: string): string {
  let cleaned = url.replace(/[.,);]+$/g, "");
  cleaned = cleaned.replace(/\\+$/g, "");
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // keep as-is if the percent-encoding is incomplete
  }
  return cleaned;
}

export function parseDriveId(url: string): ParsedDriveLink | null {
  const cleaned = canonicalizeUrl(url);
  for (const { re, kind } of PATTERNS) {
    const match = cleaned.match(re);
    if (match?.[1]) {
      return { url: cleaned, driveId: match[1], kindHint: kind };
    }
  }
  return null;
}

export function extractDriveLinksFromText(text: string): ParsedDriveLink[] {
  const found = new Map<string, ParsedDriveLink>();
  const haystack = stripNulls(decodePdfEscapes(text));
  const matches = haystack.match(LOOSE_URL) ?? [];
  for (const raw of matches) {
    const parsed = parseDriveId(raw);
    if (parsed && !found.has(parsed.driveId)) found.set(parsed.driveId, parsed);
  }
  for (const { re, kind } of PATTERNS) {
    const global = new RegExp(re.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = global.exec(haystack))) {
      const driveId = m[1];
      if (!driveId || found.has(driveId)) continue;
      found.set(driveId, { url: m[0], driveId, kindHint: kind });
    }
  }
  return [...found.values()];
}

export function extractDriveLinksFromBytes(bytes: Uint8Array): ParsedDriveLink[] {
  const latin1 = new TextDecoder("latin1").decode(bytes);
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const utf16 = decodeUtf16ish(bytes);
  const merged = [latin1, utf8, utf16].join("\n");
  return extractDriveLinksFromText(merged);
}

function decodeUtf16ish(bytes: Uint8Array): string {
  // PDFs sometimes store ASCII as UTF-16BE (null between chars).
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const a = bytes[i];
    const b = bytes[i + 1];
    if (a === 0 && b >= 32 && b < 127) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b === 0 && a >= 32 && a < 127) {
      out += String.fromCharCode(a);
      i += 1;
    }
  }
  return out;
}
