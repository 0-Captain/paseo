import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeQuotaService } from "./claude-quota-service.js";

const USAGE_BODY = {
  five_hour: { utilization: 66.0, resets_at: "2026-06-12T08:00:00+00:00" },
  seven_day: { utilization: 53.0, resets_at: "2026-06-17T00:00:00+00:00" },
  seven_day_sonnet: { utilization: 6.0, resets_at: "2026-06-17T00:00:00+00:00" },
  seven_day_opus: null,
  extra_usage: { is_enabled: false },
  some_future_field: { whatever: true },
};

function startStub(params: {
  status?: number;
  body?: unknown;
  onRequest?: (headers: Record<string, string | string[] | undefined>) => void;
}): Promise<{ server: Server; baseUrl: string; requests: () => number }> {
  let count = 0;
  return new Promise((resolveStart) => {
    const server = createServer((req, res) => {
      count += 1;
      params.onRequest?.(req.headers);
      res.statusCode = params.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(params.body ?? USAGE_BODY));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        resolveStart({
          server,
          baseUrl: `http://127.0.0.1:${address.port}`,
          requests: () => count,
        });
      }
    });
  });
}

describe("ClaudeQuotaService", () => {
  let dir: string;
  let credentialsPath: string;
  let server: Server | null = null;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "claude-quota-"));
    credentialsPath = path.join(dir, "credentials.json");
    writeFileSync(
      credentialsPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "tok_test_123" } }),
    );
  });

  afterEach(() => {
    server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  test("fetches, maps snake_case buckets, sends auth headers", async () => {
    let seenAuth: string | undefined;
    let seenBeta: string | undefined;
    const stub = await startStub({
      onRequest: (headers) => {
        seenAuth = headers.authorization as string;
        seenBeta = headers["anthropic-beta"] as string;
      },
    });
    server = stub.server;
    const service = new ClaudeQuotaService({
      baseUrl: stub.baseUrl,
      credentialsPath,
      readKeychainToken: async () => null,
    });
    const snapshot = await service.requestQuota();
    expect(seenAuth).toBe("Bearer tok_test_123");
    expect(seenBeta).toBe("oauth-2025-04-20");
    expect(snapshot?.quota.fiveHour).toEqual({
      utilization: 66,
      resetsAt: "2026-06-12T08:00:00+00:00",
    });
    expect(snapshot?.quota.sevenDaySonnet?.utilization).toBe(6);
    expect(snapshot?.quota.sevenDayOpus).toBeUndefined();
    expect(typeof snapshot?.fetchedAt).toBe("number");
  });

  test("keychain token wins over credentials file", async () => {
    let seenAuth: string | undefined;
    const stub = await startStub({
      onRequest: (headers) => {
        seenAuth = headers.authorization as string;
      },
    });
    server = stub.server;
    const service = new ClaudeQuotaService({
      baseUrl: stub.baseUrl,
      credentialsPath,
      readKeychainToken: async () => "tok_keychain",
    });
    await service.requestQuota();
    expect(seenAuth).toBe("Bearer tok_keychain");
  });

  test("returns null when no credentials anywhere", async () => {
    const stub = await startStub({});
    server = stub.server;
    const service = new ClaudeQuotaService({
      baseUrl: stub.baseUrl,
      credentialsPath: path.join(dir, "missing.json"),
      readKeychainToken: async () => null,
    });
    expect(await service.requestQuota()).toBeNull();
    expect(stub.requests()).toBe(0);
  });

  test("401 marks unavailable and clears snapshot", async () => {
    const stub = await startStub({ status: 401, body: { error: "expired" } });
    server = stub.server;
    const service = new ClaudeQuotaService({
      baseUrl: stub.baseUrl,
      credentialsPath,
      readKeychainToken: async () => null,
    });
    expect(await service.requestQuota()).toBeNull();
    expect(service.getSnapshot()).toBeNull();
  });

  test("network error keeps last good snapshot", async () => {
    const stub = await startStub({});
    server = stub.server;
    const service = new ClaudeQuotaService({
      baseUrl: stub.baseUrl,
      credentialsPath,
      readKeychainToken: async () => null,
      minFetchIntervalMs: 0,
    });
    const first = await service.requestQuota();
    expect(first).not.toBeNull();
    stub.server.close();
    server = null;
    await service.refresh();
    expect(service.getSnapshot()).toEqual(first);
  });

  test("notifyClaudeTurnCompleted debounces below minFetchIntervalMs", async () => {
    const stub = await startStub({});
    server = stub.server;
    const service = new ClaudeQuotaService({
      baseUrl: stub.baseUrl,
      credentialsPath,
      readKeychainToken: async () => null,
      minFetchIntervalMs: 60_000,
    });
    await service.requestQuota();
    service.notifyClaudeTurnCompleted();
    service.notifyClaudeTurnCompleted();
    await vi.waitFor(() => expect(stub.requests()).toBe(1));
  });

  test("onUpdate fires only when data changes", async () => {
    let body: Record<string, unknown> = USAGE_BODY;
    const stub = await startStub({});
    stub.server.removeAllListeners("request");
    stub.server.on("request", (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    server = stub.server;
    const service = new ClaudeQuotaService({
      baseUrl: stub.baseUrl,
      credentialsPath,
      readKeychainToken: async () => null,
      minFetchIntervalMs: 0,
    });
    const updates: unknown[] = [];
    service.onUpdate((payload) => updates.push(payload));
    await service.refresh();
    await service.refresh();
    expect(updates).toHaveLength(1);
    body = {
      ...USAGE_BODY,
      five_hour: { utilization: 80.0, resets_at: "2026-06-12T08:00:00+00:00" },
    };
    await service.refresh();
    expect(updates).toHaveLength(2);
  });
});
