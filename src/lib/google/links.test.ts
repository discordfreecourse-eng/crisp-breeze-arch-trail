import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractDriveLinksFromBytes, extractDriveLinksFromText } from "./links.ts";

describe("extractDriveLinksFromText", () => {
  it("dedupes folder, file, and open links", () => {
    const text = `
      https://drive.google.com/drive/folders/ABCDEFGHIJ0123456789
      https://drive.google.com/file/d/FILEIDXXXX0123456789/view
      https://drive.google.com/open?id=ABCDEFGHIJ0123456789
      https://docs.google.com/document/d/DOCIDXXXXX0123456789/edit
    `;
    const links = extractDriveLinksFromText(text);
    assert.equal(links.length, 3);
    const byId = Object.fromEntries(links.map((l) => [l.driveId, l.kindHint]));
    assert.equal(byId.ABCDEFGHIJ0123456789, "folder");
    assert.equal(byId.FILEIDXXXX0123456789, "file");
    assert.equal(byId.DOCIDXXXXX0123456789, "file");
  });

  it("ignores non-drive urls", () => {
    const links = extractDriveLinksFromText("https://example.com/file/d/nope");
    assert.equal(links.length, 0);
  });
});

describe("extractDriveLinksFromBytes", () => {
  it("finds URIs buried in PDF-like bytes", () => {
    const raw =
      "/URI (https://drive.google.com/drive/folders/PDFIDXXXX0123456789)";
    const links = extractDriveLinksFromBytes(new TextEncoder().encode(raw));
    assert.equal(links[0]?.driveId, "PDFIDXXXX0123456789");
    assert.equal(links[0]?.kindHint, "folder");
  });
});
