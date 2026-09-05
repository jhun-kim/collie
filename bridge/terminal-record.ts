import { decodedBase64Bytes, isCanonicalBase64, type ParseResult } from "./terminal-protocol.ts";

export type TerminalRecordKind = "frame" | "closed";

const MAX_FRAME_BYTES = 1536 * 1024;

function positiveU16(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 65_535
  );
}

export function parseTerminalRecord(raw: string): ParseResult<TerminalRecordKind> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid terminal stream JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "invalid terminal stream record" };
  }
  const record = Object.fromEntries(Object.entries(value));
  if (record["type"] === "terminal.closed") {
    return record["reason"] === undefined || typeof record["reason"] === "string"
      ? { ok: true, value: "closed" }
      : { ok: false, error: "invalid terminal.closed record" };
  }
  if (record["type"] !== "terminal.frame") {
    return { ok: false, error: "unknown terminal stream record" };
  }
  const bytes = record["bytes"];
  const valid =
    typeof record["seq"] === "number" &&
    Number.isSafeInteger(record["seq"]) &&
    record["seq"] >= 0 &&
    record["encoding"] === "ansi" &&
    positiveU16(record["width"]) &&
    positiveU16(record["height"]) &&
    typeof record["full"] === "boolean" &&
    typeof bytes === "string" &&
    isCanonicalBase64(bytes) &&
    decodedBase64Bytes(bytes) <= MAX_FRAME_BYTES;
  return valid
    ? { ok: true, value: "frame" }
    : { ok: false, error: "invalid terminal.frame record" };
}
