import { describe, expect, test } from "bun:test";

import type { Config } from "./config.ts";
import {
  EXTENSION_GROUPS,
  classifyExtensionRoute,
  type ExtensionAccess,
} from "./extension-routes.ts";
import { extensionRouteResponse } from "./server.ts";

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    socketPath: "/tmp/herdr.sock",
    port: 8787,
    host: "127.0.0.1",
    pollMs: 1500,
    pollIdleMs: 12_000,
    notifyDelayMs: 30_000,
    readLines: 200,
    transcript: true,
    transcriptRoot: "/tmp/claude-projects",
    submitKeys: ["Enter"],
    trustedUser: "",
    deviceHeader: "",
    deviceAllowlist: [],
    allowedOrigins: [],
    publicHosts: [],
    vapidPublic: "",
    vapidPrivate: "",
    vapidSubject: "mailto:admin@example.com",
    stateDir: "/tmp/state",
    multiSession: true,
    skipServe: false,
    ...overrides,
  };
}

function request(
  path: string,
  method: string,
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request(`https://collie.ts.net${path}`, {
    method,
    headers: {
      host: "collie.ts.net",
      origin: "https://collie.ts.net",
      ...headers,
    },
  });
}

function requestWithoutOrigin(path: string, method: string): Request {
  return new Request(`https://collie.ts.net${path}`, {
    method,
    headers: { host: "collie.ts.net" },
  });
}

describe("classifyExtensionRoute", () => {
  test("recognizes exactly the six planned endpoint groups", () => {
    // Given
    const cases = [
      ["/api/worktrees", "GET", "worktrees"],
      ["/ws/terminal/w1%3Ap1?mode=observe", "GET", "terminal"],
      ["/api/files", "GET", "files"],
      ["/api/git/status", "GET", "git"],
      ["/api/upload", "POST", "upload"],
      ["/api/blocking-message", "GET", "blocking-message"],
    ] as const;

    // When
    const groups = cases.map(([path, method]) => classifyExtensionRoute(request(path, method))?.group);

    // Then
    expect(groups).toEqual([...EXTENSION_GROUPS]);
    expect(classifyExtensionRoute(request("/api/not-planned", "GET"))).toBeNull();
  });

  test.each([
    ["/api/worktrees", "GET", "read"],
    ["/api/worktrees", "POST", "write"],
    ["/ws/terminal/w1%3Ap1?mode=observe", "GET", "read"],
    ["/ws/terminal/w1%3Ap1?mode=control", "GET", "write"],
    ["/api/files", "GET", "read"],
    ["/api/git/status", "GET", "read"],
    ["/api/git/diff", "GET", "read"],
    ["/api/git/log", "GET", "read"],
    ["/api/git/branch", "GET", "read"],
    ["/api/git/stage", "POST", "write"],
    ["/api/git/unstage", "POST", "write"],
    ["/api/git/commit", "POST", "write"],
    ["/api/upload", "POST", "write"],
    ["/api/blocking-message", "GET", "read"],
  ] as const)("classifies %s %s as %s", (path, method, access) => {
    // Given
    const req = request(path, method);

    // When
    const match = classifyExtensionRoute(req);

    // Then
    expect(match?.kind).toBe("scaffold");
    expect(match?.access).toBe(access satisfies ExtensionAccess);
  });

  test("recognizes /api/git/add only as an unsupported Git-group path", () => {
    // Given
    const req = request("/api/git/add", "POST");

    // When
    const match = classifyExtensionRoute(req);

    // Then
    expect(match).toEqual({ kind: "method-not-allowed", group: "git", access: "read" });
  });
});

describe("extensionRouteResponse", () => {
  test.each([
    ["/api/worktrees", "GET", "worktrees"],
    ["/ws/terminal/w1%3Ap1?mode=observe", "GET", "terminal"],
    ["/api/files", "GET", "files"],
    ["/api/git/status", "GET", "git"],
    ["/api/upload", "POST", "upload"],
    ["/api/blocking-message", "GET", "blocking-message"],
  ] as const)("returns 501 for the %s scaffold without falling through", async (path, method, group) => {
    // Given
    const req = request(path, method);

    // When
    const response = extensionRouteResponse(req, cfg());

    // Then
    expect(response?.status).toBe(501);
    expect(await response?.json()).toEqual({ error: "not implemented", group });
  });

  test("returns the secure JSON 501 contract for a recognized scaffold route", async () => {
    // Given
    const req = request("/api/worktrees", "GET");

    // When
    const response = extensionRouteResponse(req, cfg());

    // Then
    expect(response?.status).toBe(501);
    expect(response?.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response?.json()).toEqual({ error: "not implemented", group: "worktrees" });
  });

  test("rejects a wrong-origin write before the scaffold response", () => {
    // Given
    const req = request("/api/worktrees", "POST", { origin: "https://evil.example.com" });

    // When
    const response = extensionRouteResponse(req, cfg());

    // Then
    expect(response?.status).toBe(403);
  });

  test("rejects an unauthorized device before the scaffold response", () => {
    // Given
    const req = request("/api/git/commit", "POST");
    const config = cfg({ deviceHeader: "x-device-id", deviceAllowlist: ["phone"] });

    // When
    const response = extensionRouteResponse(req, config);

    // Then
    expect(response?.status).toBe(403);
  });

  test("allows a read route for a read-only device", () => {
    // Given
    const req = request("/api/files", "GET");
    const config = cfg({ deviceHeader: "x-device-id", deviceAllowlist: ["phone"] });

    // When
    const response = extensionRouteResponse(req, config);

    // Then
    expect(response?.status).toBe(501);
  });

  test.each([
    ["observe", "/ws/terminal/w1%3Ap1?mode=observe"],
    ["control", "/ws/terminal/w1%3Ap1?mode=control"],
  ] as const)("rejects a terminal %s handshake without Origin", (_mode, path) => {
    // Given
    const req = requestWithoutOrigin(path, "GET");

    // When
    const response = extensionRouteResponse(req, cfg());

    // Then
    expect(response?.status).toBe(403);
  });

  test.each([
    ["observe", "/ws/terminal/w1%3Ap1?mode=observe"],
    ["control", "/ws/terminal/w1%3Ap1?mode=control"],
  ] as const)("rejects a terminal %s handshake with a wrong Origin", (_mode, path) => {
    // Given
    const req = request(path, "GET", { origin: "https://evil.example.com" });

    // When
    const response = extensionRouteResponse(req, cfg());

    // Then
    expect(response?.status).toBe(403);
  });

  test.each([
    ["observe", "/ws/terminal/w1%3Ap1?mode=observe"],
    ["control", "/ws/terminal/w1%3Ap1?mode=control"],
  ] as const)("rejects a terminal %s handshake from a mismatched loopback Origin", (_mode, path) => {
    // Given
    const req = request(path, "GET", { origin: "http://localhost:8787" });

    // When
    const response = extensionRouteResponse(req, cfg());

    // Then
    expect(response?.status).toBe(403);
  });

  test.each([
    ["observe", "/ws/terminal/w1%3Ap1?mode=observe"],
    ["control", "/ws/terminal/w1%3Ap1?mode=control"],
  ] as const)("allows a configured Origin for terminal %s", (_mode, path) => {
    // Given
    const origin = "https://mobile.example.com";
    const req = request(path, "GET", { origin });

    // When
    const response = extensionRouteResponse(req, cfg({ allowedOrigins: [origin] }));

    // Then
    expect(response?.status).toBe(501);
  });

  test("/api/git/add returns 405 instead of exposing a duplicate stage endpoint", () => {
    // Given
    const req = request("/api/git/add", "POST");

    // When
    const response = extensionRouteResponse(req, cfg());

    // Then
    expect(response?.status).toBe(405);
  });

  test("returns 405 for a recognized group with an unsupported method", () => {
    // Given
    const req = request("/api/files", "POST");

    // When
    const response = extensionRouteResponse(req, cfg());

    // Then
    expect(response?.status).toBe(405);
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("does not consume an unrelated path", () => {
    // Given
    const req = request("/api/snapshot", "GET");

    // When
    const response = extensionRouteResponse(req, cfg());

    // Then
    expect(response).toBeNull();
  });
});
