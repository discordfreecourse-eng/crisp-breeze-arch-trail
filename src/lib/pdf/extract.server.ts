import {
  extractDriveLinksFromBytes,
  extractDriveLinksFromText,
  type ParsedDriveLink,
} from "@/lib/google/links";

function mergeLinks(groups: ParsedDriveLink[][]): ParsedDriveLink[] {
  const found = new Map<string, ParsedDriveLink>();
  for (const group of groups) {
    for (const link of group) {
      const prev = found.get(link.driveId);
      if (!prev) {
        found.set(link.driveId, link);
        continue;
      }
      if (prev.kindHint === "unknown" && link.kindHint !== "unknown") {
        found.set(link.driveId, link);
      }
    }
  }
  return [...found.values()];
}

export async function extractDriveLinksFromPdf(
  bytes: Uint8Array,
): Promise<ParsedDriveLink[]> {
  const fromBytes = extractDriveLinksFromBytes(bytes);
  let fromText: ParsedDriveLink[] = [];
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const result = await extractText(pdf, { mergePages: true });
    const text = Array.isArray(result.text) ? result.text.join("\n") : result.text;
    fromText = extractDriveLinksFromText(text ?? "");
  } catch (err) {
    console.warn("[raw-copy] pdf text extract failed, using byte scan", err);
  }
  return mergeLinks([fromBytes, fromText]);
}
