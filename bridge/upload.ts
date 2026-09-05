// General-purpose file upload (plan todo 7): POST /api/upload saves one file into the shared
// `<stateDir>/uploads/` temp dir and returns its absolute path, so a phone can hand an agent a
// photo/PDF/text file by path (the reply text references it; the agent reads it off disk). The
// existing pane-scoped image upload (server.ts uploadPane) targets the same directory and shares
// its TTL sweep (bridge/uploads.ts) — one directory, one sweeper, no second lifecycle to maintain.
//
// Invariants: 10 MiB cap (rejected by declared Content-Length BEFORE the body is buffered, then by
// the parsed File size), MIME allowlist (image/*, text/*, application/pdf — a phone must not be
// able to park executables on the host), and the saved name is `<ms>-<uuid>-<sanitized>` — the
// prefix makes every final path component a plain file name inside the uploads dir no matter what
// the client sent (path separators, `..`, NUL bytes are all collapsed by sanitizeFilename first).

import { mkdir } from "node:fs/promises";

/** Same cap as the pane-scoped image upload. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type UploadRouteResult =
  | { readonly ok: true; readonly data: { readonly path: string; readonly name: string; readonly size: number; readonly mime: string } }
  | { readonly ok: false; readonly status: 400 | 413 | 415; readonly error: string };

/**
 * Reduce a client-supplied filename to a safe single path component: take the basename (both `/`
 * and `\` separators), drop NUL/control characters and leading dots (`..` → nothing), map anything
 * outside the conservative allowlist to `_`, cap the length, and fall back to "file" when nothing
 * survives. The result is informational — the caller's ts-uuid prefix is what makes the save path
 * safe — but it is what the agent will see, so it stays recognizable.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const noControls = [...base]
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join("")
    .replace(/^\.+/, "");
  const cleaned = noControls.replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  const capped = cleaned.length > 120 ? `${cleaned.slice(0, 119)}…` : cleaned;
  return capped.length > 0 ? capped : "file";
}

/** MIME allowlist for parked files: images, text, and PDF. Empty (unknown) is refused. */
export function allowedUploadMime(mime: string): boolean {
  return (
    mime === "application/pdf" || mime.startsWith("image/") || mime.startsWith("text/")
  );
}

/** `<ms>-<uuid>-<sanitized>` — the prefix pins the file inside the uploads dir. Pure for tests. */
export function uploadFilename(nowMs: number, uuid: string, safeName: string): string {
  return `${nowMs}-${uuid}-${safeName}`;
}

export type UploadSaveFs = {
  mkdir(dir: string, opts: { recursive: boolean; mode: number }): Promise<void>;
  write(path: string, data: Blob): Promise<void>;
};

export const nodeUploadFs: UploadSaveFs = {
  mkdir: async (dir, opts) => {
    await mkdir(dir, opts);
  },
  write: async (path, data) => {
    await Bun.write(path, data);
  },
};

export type UploadHandler = {
  readonly stateDir: string;
  readonly fs?: UploadSaveFs;
  readonly now?: () => number;
  readonly uuid?: () => string;
};

/**
 * Parse and persist one multipart upload. The caller has already applied the write gate; size is
 * checked on the declared Content-Length first (so an oversized body never materialises), then on
 * the parsed file. The audit entry is recorded only for a successful save.
 */
export async function handleUpload(
  req: Request,
  context: UploadHandler,
  audit: { record(entry: { action: "file.upload"; device?: string | null; detail?: Record<string, unknown> }): void },
  device: string | null,
): Promise<UploadRouteResult> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    return { ok: false, status: 413, error: "file too large (max 10 MB)" };
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return { ok: false, status: 400, error: "expected multipart form data" };
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return { ok: false, status: 400, error: "no file" };
  }
  // Strip parameters ("text/plain;charset=utf-8") and lowercase — the allowlist is base-type only.
  const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!allowedUploadMime(mime)) {
    return { ok: false, status: 415, error: `unsupported type: ${mime || "unknown"}` };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, error: "file too large (max 10 MB)" };
  }
  const fs = context.fs ?? nodeUploadFs;
  const dir = `${context.stateDir}/uploads`;
  try {
    // 0700 — the uploads dir may hold sensitive user files; keep it owner-only (the state dir
    // itself is already created 0700 at startup).
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const filename = uploadFilename(
      (context.now ?? Date.now)(),
      context.uuid?.() ?? crypto.randomUUID(),
      sanitizeFilename(file.name),
    );
    const fullPath = `${dir}/${filename}`;
    await fs.write(fullPath, file);
    audit.record({
      action: "file.upload",
      device,
      detail: { filename: file.name, size: file.size, mime, saved: filename },
    });
    return {
      ok: true,
      data: { path: fullPath, name: file.name, size: file.size, mime },
    };
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : "upload failed" };
  }
}
