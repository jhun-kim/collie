import { describe, expect, test } from "bun:test";

import {
  allowedUploadMime,
  handleUpload,
  MAX_UPLOAD_BYTES,
  sanitizeFilename,
  uploadFilename,
  type UploadSaveFs,
} from "./upload.ts";

// ── Pure helpers ───────────────────────────────────────────────────────────────

describe("sanitizeFilename", () => {
  test("reduces a path to its final component", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a/b/c.txt")).toBe("c.txt");
    expect(sanitizeFilename("..\\..\\win file.exe")).toBe("win file.exe");
  });

  test("strips traversal-looking leading dots and falls back when nothing survives", () => {
    expect(sanitizeFilename("..")).toBe("file");
    expect(sanitizeFilename("...hidden.txt")).toBe("hidden.txt");
    expect(sanitizeFilename("")).toBe("file");
  });

  test("removes NUL and control characters", () => {
    expect(sanitizeFilename("a\u0000b.txt")).toBe("ab.txt");
    expect(sanitizeFilename("a\u0007b.txt")).toBe("ab.txt");
  });

  test("maps unsafe characters to underscores", () => {
    expect(sanitizeFilename("사진.png")).toBe("__.png");
    expect(sanitizeFilename("weird:name*?.txt")).toBe("weird_name__.txt");
  });

  test("caps the length", () => {
    const long = `${"x".repeat(200)}.txt`;
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(120);
  });
});

describe("allowedUploadMime", () => {
  test("allows images, text, and PDF", () => {
    for (const mime of ["image/png", "image/jpeg", "text/plain", "text/markdown", "application/pdf"]) {
      expect(allowedUploadMime(mime)).toBe(true);
    }
  });
  test("refuses everything else, including unknown", () => {
    for (const mime of ["application/zip", "application/octet-stream", "application/json", ""]) {
      expect(allowedUploadMime(mime)).toBe(false);
    }
  });
});

test("uploadFilename pins the ts-uuid prefix", () => {
  expect(uploadFilename(1234567890, "abc", "notes.txt")).toBe("1234567890-abc-notes.txt");
});

// ── Handler ────────────────────────────────────────────────────────────────────

function fakeFs() {
  const writes: Array<{ path: string; bytes: number }> = [];
  const mkdirs: Array<{ dir: string; mode: number }> = [];
  const fs: UploadSaveFs = {
    mkdir: async (dir, opts) => {
      mkdirs.push({ dir, mode: opts.mode });
    },
    write: async (path, data) => {
      writes.push({ path, bytes: data.size });
    },
  };
  return { fs, writes, mkdirs };
}

function uploadRequest(file: File, headers: Record<string, string> = {}): Request {
  const form = new FormData();
  form.append("file", file);
  return new Request("http://bridge.local/api/upload", { method: "POST", body: form, headers });
}

const baseContext = (fs: UploadSaveFs) => ({
  stateDir: "/state",
  fs,
  now: () => 1234567890,
  uuid: () => "test-uuid",
});

describe("handleUpload", () => {
  test("saves a text file into the uploads dir and records the audit entry", async () => {
    const { fs, writes, mkdirs } = fakeFs();
    const audited: unknown[] = [];
    const req = uploadRequest(new File(["hello world"], "notes.txt", { type: "text/plain" }));
    const result = await handleUpload(req, baseContext(fs), { record: (e) => audited.push(e) }, "phone");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      path: "/state/uploads/1234567890-test-uuid-notes.txt",
      name: "notes.txt",
      size: 11,
      mime: "text/plain",
    });
    expect(mkdirs).toEqual([{ dir: "/state/uploads", mode: 0o700 }]);
    expect(writes[0]?.bytes).toBe(11);
    expect(audited).toEqual([
      {
        action: "file.upload",
        device: "phone",
        detail: { filename: "notes.txt", size: 11, mime: "text/plain", saved: "1234567890-test-uuid-notes.txt" },
      },
    ]);
  });

  test("a traversal filename is sanitized into the uploads dir", async () => {
    const { fs, writes } = fakeFs();
    const req = uploadRequest(new File(["evil"], "../../evil.txt", { type: "text/plain" }));
    const result = await handleUpload(req, baseContext(fs), { record: () => {} }, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(writes[0]?.path.startsWith("/state/uploads/1234567890-test-uuid-")).toBe(true);
    expect(writes[0]?.path).toBe("/state/uploads/1234567890-test-uuid-evil.txt");
  });

  test("refuses a disallowed MIME type with 415", async () => {
    const { fs } = fakeFs();
    const req = uploadRequest(new File(["PK"], "virus.zip", { type: "application/zip" }));
    const result = await handleUpload(req, baseContext(fs), { record: () => {} }, null);
    expect(result).toEqual({ ok: false, status: 415, error: "unsupported type: application/zip" });
  });

  test("refuses an unknown (empty) MIME type with 415", async () => {
    // Bun (like some browsers) replaces an absent part content-type with octet-stream — both ways
    // the base type is not on the allowlist.
    const { fs } = fakeFs();
    const req = uploadRequest(new File(["mystery"], "mystery.bin", { type: "" }));
    const result = await handleUpload(req, baseContext(fs), { record: () => {} }, null);
    expect(result).toEqual({
      ok: false,
      status: 415,
      error: "unsupported type: application/octet-stream",
    });
  });

  test("refuses an oversized file with 413", async () => {
    const { fs } = fakeFs();
    const req = uploadRequest(new File(["a".repeat(MAX_UPLOAD_BYTES + 1)], "big.txt", { type: "text/plain" }));
    const result = await handleUpload(req, baseContext(fs), { record: () => {} }, null);
    expect(result).toEqual({ ok: false, status: 413, error: "file too large (max 10 MB)" });
  });

  test("rejects an oversized declared Content-Length before parsing the body", async () => {
    const { fs } = fakeFs();
    const req = uploadRequest(new File(["tiny"], "tiny.txt", { type: "text/plain" }), {
      "content-length": String(50 * 1024 * 1024),
    });
    const result = await handleUpload(req, baseContext(fs), { record: () => {} }, null);
    expect(result).toEqual({ ok: false, status: 413, error: "file too large (max 10 MB)" });
  });

  test("refuses a request with no file part", async () => {
    const { fs } = fakeFs();
    const form = new FormData();
    form.append("not-file", "x");
    const req = new Request("http://bridge.local/api/upload", { method: "POST", body: form });
    const result = await handleUpload(req, baseContext(fs), { record: () => {} }, null);
    expect(result).toEqual({ ok: false, status: 400, error: "no file" });
  });

  test("refuses a non-multipart body", async () => {
    const { fs } = fakeFs();
    const req = new Request("http://bridge.local/api/upload", { method: "POST", body: "plain" });
    const result = await handleUpload(req, baseContext(fs), { record: () => {} }, null);
    expect(result).toEqual({ ok: false, status: 400, error: "expected multipart form data" });
  });
});
