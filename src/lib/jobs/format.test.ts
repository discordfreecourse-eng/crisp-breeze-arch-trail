import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes, formatEta, formatGbPerHour, formatRate, mimeLabel } from "./format.ts";

describe("formatters", () => {
  it("formats bytes and rates", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.match(formatBytes(1024 ** 3), /1\.00 GB/);
    assert.equal(formatRate(0), "0.00/s");
    assert.equal(formatGbPerHour(1.5), "1.50 GB/h");
    assert.equal(formatEta(45), "45s");
    assert.equal(formatEta(null), "—");
  });

  it("labels mime types", () => {
    assert.equal(mimeLabel("application/vnd.google-apps.folder", "folder"), "Folder");
    assert.equal(mimeLabel("application/pdf", "file"), "PDF");
    assert.equal(mimeLabel("video/quicktime", "file"), "Video");
  });
});
