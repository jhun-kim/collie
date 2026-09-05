import { describe, expect, test } from "bun:test";

import {
  parseTerminalClientMessage,
  parseTerminalRequest,
  terminalArgv,
} from "./terminal-protocol.ts";

describe("parseTerminalRequest", () => {
  test("parses an observe request with bounded defaults", () => {
    // Given
    const request = new Request("http://collie/ws/terminal/w1%3Ap1");

    // When
    const parsed = parseTerminalRequest(request);

    // Then
    expect(parsed).toEqual({
      ok: true,
      value: { paneId: "w1:p1", mode: "observe", cols: 120, rows: 40 },
    });
  });

  test.each(["0", "-1", "1.5", "65536", "wat"])(
    "rejects an invalid terminal dimension %s",
    (dimension) => {
      // Given
      const request = new Request(
        `http://collie/ws/terminal/w1%3Ap1?cols=${dimension}&rows=40`,
      );

      // When
      const parsed = parseTerminalRequest(request);

      // Then
      expect(parsed.ok).toBe(false);
    },
  );

  test("rejects an unknown mode and a malformed pane path", () => {
    // Given
    const requests = [
      new Request("http://collie/ws/terminal/w1%3Ap1?mode=write"),
      new Request("http://collie/ws/terminal/"),
    ];

    // When
    const parsed = requests.map(parseTerminalRequest);

    // Then
    expect(parsed.every((result) => !result.ok)).toBe(true);
  });

  test("rejects duplicate terminal query parameters", () => {
    // Given
    const requests = [
      new Request("http://collie/ws/terminal/w1%3Ap1?mode=observe&mode=control"),
      new Request("http://collie/ws/terminal/w1%3Ap1?cols=80&cols=120"),
      new Request("http://collie/ws/terminal/w1%3Ap1?rows=24&rows=40"),
    ];

    // When
    const parsed = requests.map(parseTerminalRequest);

    // Then
    expect(parsed.every((result) => !result.ok)).toBe(true);
  });
});

describe("terminalArgv", () => {
  test("builds exact observe and control argv arrays", () => {
    // Given
    const observe = { paneId: "w1:p1", mode: "observe", cols: 120, rows: 40 } as const;
    const control = { paneId: "w1:p1", mode: "control", cols: 100, rows: 30 } as const;

    // When
    const argv = [terminalArgv(observe), terminalArgv(control)];

    // Then
    expect(argv).toEqual([
      ["herdr", "terminal", "session", "observe", "w1:p1", "--cols", "120", "--rows", "40"],
      [
        "herdr",
        "terminal",
        "session",
        "control",
        "w1:p1",
        "--takeover",
        "--cols",
        "100",
        "--rows",
        "30",
      ],
    ]);
  });
});

describe("parseTerminalClientMessage", () => {
  test.each([
    [
      '{"cmd":"terminal.input","text":"ls\\n"}',
      '{"type":"terminal.input","text":"ls\\n"}\n',
    ],
    [
      '{"cmd":"terminal.input","base64":"G1tB"}',
      '{"type":"terminal.input","bytes":"G1tB"}\n',
    ],
    [
      '{"cmd":"terminal.resize","cols":100,"rows":30,"cellWidthPx":8,"cellHeightPx":16}',
      '{"type":"terminal.resize","cols":100,"rows":30,"cell_width_px":8,"cell_height_px":16}\n',
    ],
    [
      '{"cmd":"terminal.scroll","direction":"up","lines":3,"source":"page_key"}',
      '{"type":"terminal.scroll","direction":"up","lines":3,"source":"page_key"}\n',
    ],
    ['{"cmd":"terminal.release"}', '{"type":"terminal.release"}\n'],
  ] as const)("translates a Collie command to Herdr NDJSON", (raw, line) => {
    // Given / When
    const parsed = parseTerminalClientMessage(raw, "control");

    // Then
    expect(parsed).toEqual({
      ok: true,
      value: { line, release: raw.includes("terminal.release") },
    });
  });

  test.each([
    '{"cmd":"terminal.input","text":"x","base64":"eA=="}',
    '{"cmd":"terminal.input"}',
    '{"cmd":"terminal.input","text":""}',
    '{"cmd":"terminal.input","base64":""}',
    '{"cmd":"terminal.input","base64":"%%%"}',
    '{"cmd":"terminal.input","base64":"YR=="}',
    '{"cmd":"terminal.resize","cols":0,"rows":40}',
    '{"cmd":"terminal.resize","cols":80,"rows":40,"cellWidthPx":0}',
    '{"cmd":"terminal.resize","cols":80,"rows":40,"cellHeightPx":4294967296}',
    '{"cmd":"terminal.scroll","direction":"left","lines":1}',
    '{"cmd":"terminal.scroll","direction":"up","lines":0}',
    '{"cmd":"unknown"}',
    "not-json",
  ])("rejects malformed or unknown control input", (raw) => {
    // Given / When
    const parsed = parseTerminalClientMessage(raw, "control");

    // Then
    expect(parsed.ok).toBe(false);
  });

  test("observe mode rejects every client command", () => {
    // Given / When
    const parsed = parseTerminalClientMessage('{"cmd":"terminal.release"}', "observe");

    // Then
    expect(parsed.ok).toBe(false);
  });

  test("rejects decoded input larger than one MiB", () => {
    // Given
    const raw = JSON.stringify({ cmd: "terminal.input", text: "x".repeat(1024 * 1024 + 1) });

    // When
    const parsed = parseTerminalClientMessage(raw, "control");

    // Then
    expect(parsed.ok).toBe(false);
  });

  test("measures UTF-8 and decoded base64 input bytes", () => {
    // Given
    const utf8 = JSON.stringify({
      cmd: "terminal.input",
      text: "한".repeat(Math.floor(1024 * 1024 / 3) + 1),
    });
    const base64 = JSON.stringify({
      cmd: "terminal.input",
      base64: Buffer.alloc(1024 * 1024 + 1).toString("base64"),
    });

    // When
    const parsed = [
      parseTerminalClientMessage(utf8, "control"),
      parseTerminalClientMessage(base64, "control"),
    ];

    // Then
    expect(parsed.every((result) => !result.ok)).toBe(true);
  });

  test("rejects non-object JSON and wrong field types", () => {
    // Given
    const raw = ["null", "[]", '"text"', '{"cmd":1}', '{"cmd":"terminal.resize","cols":"80","rows":40}'];

    // When
    const parsed = raw.map((value) => parseTerminalClientMessage(value, "control"));

    // Then
    expect(parsed.every((result) => !result.ok)).toBe(true);
  });
});
