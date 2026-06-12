# Claude Subscription Quota Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Claude subscription quota (5h session + weekly) as a concentric dual-ring meter next to the context-window meter in the composer, fed by a daemon-side service that reads the host's Claude Code OAuth credentials.

**Architecture:** A new `ClaudeQuotaService` in the daemon reads the OAuth token (macOS Keychain → `~/.claude/.credentials.json` fallback), fetches `https://api.anthropic.com/api/oauth/usage` (debounced on Claude `turn_completed` events + 5-min fallback poll), and broadcasts changes. A new dotted-namespace RPC pair (`usage.claude.get_quota.request/.response`) plus a one-way broadcast (`usage.claude.quota_updated`) carry the data. The app gates on `server_info.features.claudeQuota`, fetches via react-query, subscribes to pushes, and renders a `ClaudeQuotaMeter` next to the `ContextWindowMeter`.

**Tech Stack:** Zod (protocol), Node (daemon service, no new deps), React Native + react-native-svg + Unistyles (app), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-claude-quota-ui-design.md` — read it first.

**Repo rules that apply to every task** (from CLAUDE.md / docs):

- Run `npm run typecheck` and `npm run lint` after every change. Lint single files via `npm run lint -- <path>`.
- NEVER run a full test suite. Only run the specific new test file: `npx vitest run <file> --bail=1` from the package dir.
- After protocol changes, rebuild consumers: `npm run build:client` (protocol+client) or `npm run build:server` (everything server-side) from the repo root, otherwise cross-package typecheck reads stale `dist` declarations.
- All protocol fields added here are `.optional()` — never required.
- NEVER restart the daemon on port 6767.

---

## Verified upstream API (do not re-verify; already tested live)

`GET https://api.anthropic.com/api/oauth/usage` with headers
`Authorization: Bearer <token>` and `anthropic-beta: oauth-2025-04-20` returns:

```json
{
  "five_hour": { "utilization": 66.0, "resets_at": "2026-06-12T08:00:00+00:00" },
  "seven_day": { "utilization": 53.0, "resets_at": "2026-06-17T00:00:00+00:00" },
  "seven_day_sonnet": { "utilization": 6.0, "resets_at": "2026-06-17T00:00:00+00:00" },
  "seven_day_opus": null,
  "extra_usage": { "is_enabled": false }
}
```

Token source: macOS Keychain item `Claude Code-credentials` (read with
`security find-generic-password -s "Claude Code-credentials" -w`) or
`~/.claude/.credentials.json`; both contain JSON with path
`claudeAiOauth.accessToken`.

---

### Task 0: Branch

**Files:** none

- [ ] **Step 0.1:** From repo root: `git checkout -b feat/claude-quota-display` (current branch `feat/add-claude-fable-5` already contains the spec commits — branch from it).

---

### Task 1: Protocol — schemas, unions, feature flag

**Files:**

- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/protocol/src/messages.claude-quota.test.ts` (create)

- [ ] **Step 1.1: Write the failing test**

Create `packages/protocol/src/messages.claude-quota.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  ClaudeQuotaSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";

describe("claude quota protocol", () => {
  test("get_quota request round-trips through the inbound union", () => {
    const msg = { type: "usage.claude.get_quota.request", requestId: "req_1" };
    const parsed = SessionInboundMessageSchema.parse(msg);
    expect(parsed).toMatchObject(msg);
  });

  test("get_quota response round-trips through the outbound union", () => {
    const msg = {
      type: "usage.claude.get_quota.response",
      payload: {
        requestId: "req_1",
        available: true,
        quota: {
          fiveHour: { utilization: 66, resetsAt: "2026-06-12T08:00:00+00:00" },
          sevenDay: { utilization: 53, resetsAt: "2026-06-17T00:00:00+00:00" },
        },
        fetchedAt: 1765500000000,
      },
    };
    const parsed = SessionOutboundMessageSchema.parse(msg);
    expect(parsed).toMatchObject(msg);
  });

  test("unavailable response parses without quota or fetchedAt", () => {
    const msg = {
      type: "usage.claude.get_quota.response",
      payload: { requestId: "req_1", available: false },
    };
    expect(() => SessionOutboundMessageSchema.parse(msg)).not.toThrow();
  });

  test("quota_updated broadcast round-trips through the outbound union", () => {
    const msg = {
      type: "usage.claude.quota_updated",
      payload: {
        available: true,
        quota: { fiveHour: { utilization: 10 } },
        fetchedAt: 1765500000000,
      },
    };
    expect(() => SessionOutboundMessageSchema.parse(msg)).not.toThrow();
  });

  test("quota with all buckets missing still parses (forward compat)", () => {
    expect(() => ClaudeQuotaSchema.parse({})).not.toThrow();
  });

  test("bucket without resetsAt parses", () => {
    expect(() => ClaudeQuotaSchema.parse({ fiveHour: { utilization: 5 } })).not.toThrow();
  });

  test("server_info without claudeQuota feature still parses (old daemon)", () => {
    const payload = {
      status: "server_info",
      serverId: "srv_1",
      features: { providersSnapshot: true },
    };
    const parsed = ServerInfoStatusPayloadSchema.parse(payload);
    expect(parsed.features?.claudeQuota).toBeUndefined();
  });

  test("server_info with claudeQuota=true parses", () => {
    const payload = {
      status: "server_info",
      serverId: "srv_1",
      features: { claudeQuota: true },
    };
    const parsed = ServerInfoStatusPayloadSchema.parse(payload);
    expect(parsed.features?.claudeQuota).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

From `packages/protocol`: `npx vitest run src/messages.claude-quota.test.ts --bail=1`
Expected: FAIL (`ClaudeQuotaSchema` not exported; unions reject the message types).

- [ ] **Step 1.3: Add schemas to `packages/protocol/src/messages.ts`**

Near the other RPC request schemas (the `CheckoutGithubSetAutoMergeRequestSchema` at ~line 1433 is the reference pattern), add:

```ts
export const ClaudeQuotaBucketSchema = z.object({
  utilization: z.number(),
  resetsAt: z.string().optional(),
});

// All buckets optional: the upstream Anthropic endpoint is undocumented and
// fields appear/disappear per account type.
export const ClaudeQuotaSchema = z.object({
  fiveHour: ClaudeQuotaBucketSchema.optional(),
  sevenDay: ClaudeQuotaBucketSchema.optional(),
  sevenDaySonnet: ClaudeQuotaBucketSchema.optional(),
  sevenDayOpus: ClaudeQuotaBucketSchema.optional(),
});

export const UsageClaudeGetQuotaRequestSchema = z.object({
  type: z.literal("usage.claude.get_quota.request"),
  requestId: z.string(),
});
```

Near the response schemas (reference: `CheckoutGithubSetAutoMergeResponseSchema` at ~line 3165), add:

```ts
export const UsageClaudeGetQuotaResponseSchema = z.object({
  type: z.literal("usage.claude.get_quota.response"),
  payload: z.object({
    requestId: z.string(),
    available: z.boolean(),
    quota: ClaudeQuotaSchema.optional(),
    fetchedAt: z.number().optional(),
  }),
});

// One-way daemon→client broadcast; intentionally has no `.request` counterpart
// (pushed whenever the daemon-side quota snapshot changes).
export const UsageClaudeQuotaUpdatedMessageSchema = z.object({
  type: z.literal("usage.claude.quota_updated"),
  payload: z.object({
    available: z.boolean(),
    quota: ClaudeQuotaSchema.optional(),
    fetchedAt: z.number().optional(),
  }),
});

export type ClaudeQuota = z.infer<typeof ClaudeQuotaSchema>;
export type ClaudeQuotaStatePayload = z.infer<typeof UsageClaudeQuotaUpdatedMessageSchema>["payload"];
```

- [ ] **Step 1.4: Register in the unions and the features object**

1. Add `UsageClaudeGetQuotaRequestSchema,` to the `SessionInboundMessageSchema` discriminated union (next to `CheckoutGithubSetAutoMergeRequestSchema` at ~line 1909).
2. Add `UsageClaudeGetQuotaResponseSchema,` and `UsageClaudeQuotaUpdatedMessageSchema,` to `SessionOutboundMessageSchema` (next to `CheckoutGithubSetAutoMergeResponseSchema` at ~line 3771).
3. In `ServerInfoStatusPayloadSchema.features` (~line 2133), add:

```ts
// COMPAT(claudeQuota): added in v0.1.92, remove gate after 2026-12-13.
claudeQuota: z.boolean().optional(),
```

- [ ] **Step 1.5: Run the test to verify it passes**

From `packages/protocol`: `npx vitest run src/messages.claude-quota.test.ts --bail=1`
Expected: PASS (all 8 tests).

- [ ] **Step 1.6: Rebuild + typecheck + lint**

From repo root: `npm run build:client && npm run typecheck && npm run lint -- packages/protocol/src/messages.ts`
Expected: clean.

- [ ] **Step 1.7: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.claude-quota.test.ts
git commit -m "feat(protocol): add usage.claude quota RPC schemas and claudeQuota feature flag"
```

---

### Task 2: Daemon — ClaudeQuotaService

**Files:**

- Create: `packages/server/src/services/claude-quota-service.ts`
- Test: `packages/server/src/services/claude-quota-service.test.ts` (create)

The service is fully dependency-injected so tests use a real local HTTP server and a temp credentials file — no mocks of our own code (per `docs/testing.md`).

- [ ] **Step 2.1: Write the failing tests**

Create `packages/server/src/services/claude-quota-service.test.ts`:

```ts
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
        resolveStart({ server, baseUrl: `http://127.0.0.1:${address.port}`, requests: () => count });
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
    // null bucket and unknown fields are dropped, not errors
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
    await service.requestQuota(); // 1st fetch
    service.notifyClaudeTurnCompleted(); // within 60s → skipped
    service.notifyClaudeTurnCompleted();
    await vi.waitFor(() => expect(stub.requests()).toBe(1));
  });

  test("onUpdate fires only when data changes", async () => {
    let body: Record<string, unknown> = USAGE_BODY;
    const stub = await startStub({ body: undefined, onRequest: () => {} });
    // re-create stub with dynamic body
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
    await service.refresh(); // identical body → no second update
    expect(updates).toHaveLength(1);
    body = { ...USAGE_BODY, five_hour: { utilization: 80.0, resets_at: "2026-06-12T08:00:00+00:00" } };
    await service.refresh();
    expect(updates).toHaveLength(2);
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

From `packages/server`: `npx vitest run src/services/claude-quota-service.test.ts --bail=1`
Expected: FAIL (module not found).

- [ ] **Step 2.3: Implement the service**

Create `packages/server/src/services/claude-quota-service.ts`:

```ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ClaudeQuota, ClaudeQuotaStatePayload } from "@getpaseo/protocol";

const execFileAsync = promisify(execFile);

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MIN_FETCH_INTERVAL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface ClaudeQuotaSnapshot {
  quota: ClaudeQuota;
  fetchedAt: number;
}

interface ClaudeQuotaServiceOptions {
  baseUrl?: string;
  credentialsPath?: string;
  readKeychainToken?: () => Promise<string | null>;
  minFetchIntervalMs?: number;
  pollIntervalMs?: number;
  logger?: { warn: (obj: unknown, msg: string) => void; debug: (obj: unknown, msg: string) => void };
}

async function readKeychainTokenDefault(): Promise<string | null> {
  if (platform() !== "darwin") {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ]);
    return extractAccessToken(stdout.trim());
  } catch {
    return null;
  }
}

function extractAccessToken(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
    if (typeof oauth !== "object" || oauth === null) {
      return null;
    }
    const token = (oauth as Record<string, unknown>).accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function parseUsageResponse(json: unknown): ClaudeQuota | null {
  if (typeof json !== "object" || json === null) {
    return null;
  }
  const buckets: Array<[string, keyof ClaudeQuota]> = [
    ["five_hour", "fiveHour"],
    ["seven_day", "sevenDay"],
    ["seven_day_sonnet", "sevenDaySonnet"],
    ["seven_day_opus", "sevenDayOpus"],
  ];
  const quota: ClaudeQuota = {};
  for (const [source, target] of buckets) {
    const bucket = (json as Record<string, unknown>)[source];
    if (typeof bucket !== "object" || bucket === null) {
      continue;
    }
    const utilization = (bucket as Record<string, unknown>).utilization;
    const resetsAt = (bucket as Record<string, unknown>).resets_at;
    if (typeof utilization === "number") {
      quota[target] = {
        utilization,
        ...(typeof resetsAt === "string" ? { resetsAt } : {}),
      };
    }
  }
  return Object.keys(quota).length > 0 ? quota : null;
}

export class ClaudeQuotaService {
  private readonly baseUrl: string;
  private readonly credentialsPath: string;
  private readonly readKeychainToken: () => Promise<string | null>;
  private readonly minFetchIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly logger: ClaudeQuotaServiceOptions["logger"];

  private snapshot: ClaudeQuotaSnapshot | null = null;
  private lastFetchAt = 0;
  private inflight: Promise<ClaudeQuotaSnapshot | null> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(payload: ClaudeQuotaStatePayload) => void>();

  constructor(options: ClaudeQuotaServiceOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.credentialsPath =
      options.credentialsPath ?? path.join(homedir(), ".claude", ".credentials.json");
    this.readKeychainToken = options.readKeychainToken ?? readKeychainTokenDefault;
    this.minFetchIntervalMs = options.minFetchIntervalMs ?? DEFAULT_MIN_FETCH_INTERVAL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.logger = options.logger;
  }

  getSnapshot(): ClaudeQuotaSnapshot | null {
    return this.snapshot;
  }

  onUpdate(listener: (payload: ClaudeQuotaStatePayload) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** RPC entry: serve cache when present, otherwise fetch immediately. */
  async requestQuota(): Promise<ClaudeQuotaSnapshot | null> {
    if (this.snapshot) {
      return this.snapshot;
    }
    return await this.fetchNow();
  }

  /** Trigger from Claude turn_completed; debounced by minFetchIntervalMs. */
  notifyClaudeTurnCompleted(): void {
    void this.refresh();
  }

  /** Debounced refresh. Public for tests and the poll timer. */
  async refresh(): Promise<void> {
    if (Date.now() - this.lastFetchAt < this.minFetchIntervalMs) {
      return;
    }
    await this.fetchNow();
  }

  start(params: { hasConnectedClients: () => boolean }): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      if (!params.hasConnectedClients()) {
        return;
      }
      void this.refresh();
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async fetchNow(): Promise<ClaudeQuotaSnapshot | null> {
    if (this.inflight) {
      return await this.inflight;
    }
    this.inflight = this.doFetch();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async readToken(): Promise<string | null> {
    const keychainToken = await this.readKeychainToken();
    if (keychainToken) {
      return keychainToken;
    }
    try {
      const raw = await readFile(this.credentialsPath, "utf8");
      return extractAccessToken(raw);
    } catch {
      return null;
    }
  }

  private async doFetch(): Promise<ClaudeQuotaSnapshot | null> {
    const token = await this.readToken();
    if (!token) {
      return null;
    }
    this.lastFetchAt = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/api/oauth/usage`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        this.logger?.debug({ status: response.status }, "claude-quota: token rejected");
        this.setSnapshot(null);
        return null;
      }
      if (!response.ok) {
        this.logger?.warn({ status: response.status }, "claude-quota: fetch failed");
        return this.snapshot;
      }
      const quota = parseUsageResponse(await response.json());
      if (!quota) {
        return this.snapshot;
      }
      this.setSnapshot({ quota, fetchedAt: Date.now() });
      return this.snapshot;
    } catch (err) {
      // Network errors keep the last good snapshot.
      this.logger?.warn({ err }, "claude-quota: fetch error");
      return this.snapshot;
    }
  }

  private setSnapshot(next: ClaudeQuotaSnapshot | null): void {
    const changed =
      JSON.stringify(this.snapshot?.quota ?? null) !== JSON.stringify(next?.quota ?? null) ||
      Boolean(this.snapshot) !== Boolean(next);
    this.snapshot = next;
    if (!changed) {
      return;
    }
    const payload: ClaudeQuotaStatePayload = next
      ? { available: true, quota: next.quota, fetchedAt: next.fetchedAt }
      : { available: false };
    for (const listener of this.listeners) {
      listener(payload);
    }
  }
}
```

Notes for the implementer:

- If `@getpaseo/protocol` is not the import path used by neighboring files in `packages/server/src/services/`, match whatever `github-service.ts` uses for protocol types.
- The `ClaudeQuota`/`ClaudeQuotaStatePayload` types come from Task 1; run `npm run build:client` first if typecheck can't find them.

- [ ] **Step 2.4: Run tests to verify they pass**

From `packages/server`: `npx vitest run src/services/claude-quota-service.test.ts --bail=1`
Expected: PASS (7 tests).

- [ ] **Step 2.5: Typecheck + lint + commit**

```bash
npm run typecheck && npm run lint -- packages/server/src/services/claude-quota-service.ts
git add packages/server/src/services/claude-quota-service.ts packages/server/src/services/claude-quota-service.test.ts
git commit -m "feat(server): add ClaudeQuotaService fetching subscription usage"
```

---

### Task 3: Daemon wiring — bootstrap, session RPC handler, broadcast, feature flag

**Files:**

- Modify: `packages/server/src/server/bootstrap.ts` (service creation ~line 526 area; agentManager ~545; wsServer ~959)
- Modify: `packages/server/src/server/websocket-server.ts` (constructor; features at ~lines 1050–1066; near `broadcastDaemonConfigChanged` ~line 1093)
- Modify: `packages/server/src/server/session.ts` (switch ~line 2066 area; handlers near `handleCheckoutGithubSetAutoMergeRequest` ~line 5491)

This task has no isolated unit test of its own (it is pure wiring); correctness is proven by typecheck plus the existing construction call sites compiling. Follow the **github service** as the threading pattern everywhere: `bootstrap.ts` creates it → passes positionally to `VoiceAssistantWebSocketServer` → server passes it into each `Session`.

- [ ] **Step 3.1: bootstrap.ts — create + wire the service**

Next to `const github = createGitHubService();` (~line 526):

```ts
const claudeQuotaService = new ClaudeQuotaService({ logger });
```

(import `ClaudeQuotaService` from `../services/claude-quota-service.js` — adjust relative depth to match neighbors).

After `agentManager` is constructed (~line 551):

```ts
agentManager.subscribe(
  (event) => {
    if (
      event.type === "agent_stream" &&
      event.event.type === "turn_completed" &&
      event.event.provider === "claude"
    ) {
      claudeQuotaService.notifyClaudeTurnCompleted();
    }
  },
  { replayState: false },
);
```

Pass `claudeQuotaService` into the `VoiceAssistantWebSocketServer` constructor call (~line 959) directly after the `github` argument.

After `wsServer` is assigned:

```ts
claudeQuotaService.start({ hasConnectedClients: () => wsServer.hasConnectedClients() });
```

If bootstrap has a shutdown/dispose path that closes the wsServer, add `claudeQuotaService.stop()` there; if there is no such path, the `unref()`ed timer is sufficient — do not invent a new shutdown framework.

- [ ] **Step 3.2: websocket-server.ts — accept service, broadcast updates, expose connection count, feature flag**

1. Add a constructor parameter `private readonly claudeQuotaService: ClaudeQuotaService,` directly after the `github` parameter (mirror its style). Import the type.
2. In the constructor body, subscribe and broadcast (the `wrapSessionMessage` import already exists at line 25):

```ts
this.claudeQuotaService.onUpdate((payload) => {
  this.broadcast(
    wrapSessionMessage({
      type: "usage.claude.quota_updated",
      payload,
    }),
  );
});
```

3. Add a public method near `broadcast` (~line 626):

```ts
public hasConnectedClients(): boolean {
  return this.sessions.size > 0;
}
```

4. In the hello/server_info features block (~lines 1052–1066) add:

```ts
// COMPAT(claudeQuota): added in v0.1.92, remove gate after 2026-12-13.
claudeQuota: true,
```

5. Pass `claudeQuotaService` through to `Session` construction the same way `github` is passed (find where sessions are created inside websocket-server and mirror the github argument).

- [ ] **Step 3.3: session.ts — handle the RPC**

1. Session constructor/options: add `claudeQuotaService: ClaudeQuotaService` exactly the way `github` is received and stored.
2. In the inbound message switch (~line 2066), add:

```ts
case "usage.claude.get_quota.request":
  return this.handleUsageClaudeGetQuotaRequest(msg);
```

3. Add the handler near `handleCheckoutGithubSetAutoMergeRequest` (~line 5491):

```ts
private async handleUsageClaudeGetQuotaRequest(
  msg: Extract<SessionInboundMessage, { type: "usage.claude.get_quota.request" }>,
): Promise<void> {
  const snapshot = await this.claudeQuotaService.requestQuota();
  this.emit({
    type: "usage.claude.get_quota.response",
    payload: snapshot
      ? {
          requestId: msg.requestId,
          available: true,
          quota: snapshot.quota,
          fetchedAt: snapshot.fetchedAt,
        }
      : { requestId: msg.requestId, available: false },
  });
}
```

If `session.ts` imports message types via its local `./messages.js` re-export (line 22), add any newly needed type re-exports there following the existing pattern.

- [ ] **Step 3.4: Fix all construction call sites**

`new VoiceAssistantWebSocketServer(` and `new Session(`-style call sites in tests/harnesses will now fail typecheck. Run from repo root:

```bash
npm run build:server && npm run typecheck
```

For every failing call site, pass a real `new ClaudeQuotaService({})` (cheap, no I/O until used) — do NOT build mock objects. `rg -l "new VoiceAssistantWebSocketServer"` to enumerate.

Expected: typecheck clean.

- [ ] **Step 3.5: Lint + commit**

```bash
npm run lint -- packages/server/src/server/bootstrap.ts packages/server/src/server/websocket-server.ts packages/server/src/server/session.ts
git add -A packages/server
git commit -m "feat(server): wire Claude quota service into daemon RPC and broadcast"
```

---

### Task 4: Client — daemon-client RPC method

**Files:**

- Modify: `packages/client/src/daemon-client.ts` (near `checkoutGithubSetAutoMerge`, ~line 3009)

- [ ] **Step 4.1: Add the method**

```ts
async getClaudeQuota(
  requestId?: string,
): Promise<CorrelatedResponsePayload<"usage.claude.get_quota.response">> {
  return this.sendNamespacedCorrelatedSessionRequest<"usage.claude.get_quota.response">({
    requestId,
    message: { type: "usage.claude.get_quota.request" },
    timeout: 15000,
  });
}
```

Match the surrounding style: if neighboring methods declare an exported payload type alias (like `CheckoutGithubSetAutoMergePayload`), create and export `export type ClaudeQuotaRpcPayload = CorrelatedResponsePayload<"usage.claude.get_quota.response">;` and use it as the return type.

- [ ] **Step 4.2: Build + typecheck + lint + commit**

```bash
npm run build:client && npm run typecheck && npm run lint -- packages/client/src/daemon-client.ts
git add packages/client/src/daemon-client.ts
git commit -m "feat(client): add getClaudeQuota RPC method"
```

---

### Task 5: App — `useClaudeQuota` hook

**Files:**

- Create: `packages/app/src/hooks/use-claude-quota.ts`

Model: `packages/app/src/hooks/use-daemon-config.ts` (request on mount via react-query + `client.on` push subscription) and the feature gate from `use-providers-snapshot.ts` line 121.

- [ ] **Step 5.1: Implement the hook**

```ts
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClaudeQuota } from "@getpaseo/protocol";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export interface ClaudeQuotaState {
  quota: ClaudeQuota;
  fetchedAt: number | null;
}

interface QuotaQueryData {
  available: boolean;
  quota?: ClaudeQuota;
  fetchedAt?: number;
}

function claudeQuotaQueryKey(serverId: string | null) {
  return ["claude-quota", serverId ?? "none"] as const;
}

export function useClaudeQuota(serverId: string | null): ClaudeQuotaState | null {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsQuota = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.claudeQuota === true,
  );
  const queryKey = useMemo(() => claudeQuotaQueryKey(serverId), [serverId]);

  const query = useQuery<QuotaQueryData>({
    queryKey,
    enabled: Boolean(serverId && client && isConnected && supportsQuota),
    staleTime: Infinity,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return await client.getClaudeQuota();
    },
  });

  useEffect(() => {
    if (!client || !isConnected || !serverId || !supportsQuota) {
      return;
    }
    return client.on("usage.claude.quota_updated", (message) => {
      if (message.type !== "usage.claude.quota_updated") {
        return;
      }
      queryClient.setQueryData<QuotaQueryData>(queryKey, message.payload);
    });
  }, [client, isConnected, queryClient, queryKey, serverId, supportsQuota]);

  const data = query.data;
  if (!data?.available || !data.quota) {
    return null;
  }
  return { quota: data.quota, fetchedAt: data.fetchedAt ?? null };
}
```

Adjust import paths/names to what `use-daemon-config.ts` actually uses (e.g. the exact session-store import and `useHostRuntime*` names — copy from that file).

- [ ] **Step 5.2: Typecheck + lint + commit**

```bash
npm run typecheck && npm run lint -- packages/app/src/hooks/use-claude-quota.ts
git add packages/app/src/hooks/use-claude-quota.ts
git commit -m "feat(app): add useClaudeQuota hook with push subscription"
```

---

### Task 6: App — `ClaudeQuotaMeter` component

**Files:**

- Create: `packages/app/src/components/claude-quota-meter.tsx`
- Test: `packages/app/src/components/claude-quota-meter.test.ts` (create — pure helpers only)

Visual spec (user-approved mockup): single 18px SVG; outer ring r=7.5 stroke 2 = 5h bucket in Claude orange `#D97757`; inner ring r=4 stroke 2 = weekly bucket in `#E5A088` (dark themes) / `#C97D5E` (light themes); track `theme.colors.surface3`; a ring turns `theme.colors.destructive` at ≥90% utilization (NO amber tier — deliberate, see spec). Theme darkness comes from `theme.colorScheme` (`"dark" | "light"`, defined in `packages/app/src/styles/theme.ts` lines 555/573). Copy the SVG/Tooltip mechanics from `packages/app/src/components/context-window-meter.tsx` — including its theme-access approach (it uses `useUnistyles()`; matching the sibling component beats inventing a new pattern here; do NOT introduce `useUnistyles` anywhere else).

- [ ] **Step 6.1: Write the failing helper tests**

Create `packages/app/src/components/claude-quota-meter.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  formatResetLabel,
  formatUpdatedAgo,
  resolveRingColor,
  CLAUDE_ORANGE,
  CLAUDE_ORANGE_INNER_DARK,
  CLAUDE_ORANGE_INNER_LIGHT,
} from "./claude-quota-meter";

const DESTRUCTIVE = "#c64f43";

describe("resolveRingColor", () => {
  test("outer ring is Claude orange under 90%", () => {
    expect(resolveRingColor({ utilization: 89.9, ring: "outer", colorScheme: "dark", destructive: DESTRUCTIVE })).toBe(CLAUDE_ORANGE);
  });
  test("inner ring uses dark variant on dark scheme", () => {
    expect(resolveRingColor({ utilization: 10, ring: "inner", colorScheme: "dark", destructive: DESTRUCTIVE })).toBe(CLAUDE_ORANGE_INNER_DARK);
  });
  test("inner ring uses light variant on light scheme", () => {
    expect(resolveRingColor({ utilization: 10, ring: "inner", colorScheme: "light", destructive: DESTRUCTIVE })).toBe(CLAUDE_ORANGE_INNER_LIGHT);
  });
  test("either ring turns destructive at >=90%", () => {
    expect(resolveRingColor({ utilization: 90, ring: "outer", colorScheme: "dark", destructive: DESTRUCTIVE })).toBe(DESTRUCTIVE);
    expect(resolveRingColor({ utilization: 95, ring: "inner", colorScheme: "light", destructive: DESTRUCTIVE })).toBe(DESTRUCTIVE);
  });
});

describe("formatResetLabel", () => {
  const now = new Date("2026-06-12T03:00:00Z");
  test("same-day reset renders time only", () => {
    const label = formatResetLabel("2026-06-12T08:00:00Z", now);
    // exact string is timezone-dependent; assert shape: contains digits + no weekday
    expect(label).toMatch(/\d/);
    expect(label).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });
  test("future-day reset includes weekday", () => {
    const label = formatResetLabel("2026-06-17T00:00:00Z", now);
    expect(label).toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });
  test("invalid date returns null", () => {
    expect(formatResetLabel("not-a-date", now)).toBeNull();
    expect(formatResetLabel(undefined, now)).toBeNull();
  });
});

describe("formatUpdatedAgo", () => {
  const nowMs = Date.parse("2026-06-12T03:00:00Z");
  test("under a minute", () => {
    expect(formatUpdatedAgo(nowMs - 20_000, nowMs)).toBe("Updated just now");
  });
  test("minutes", () => {
    expect(formatUpdatedAgo(nowMs - 2 * 60_000, nowMs)).toBe("Updated 2m ago");
  });
  test("hours", () => {
    expect(formatUpdatedAgo(nowMs - 3 * 3_600_000, nowMs)).toBe("Updated 3h ago");
  });
  test("null fetchedAt returns null", () => {
    expect(formatUpdatedAgo(null, nowMs)).toBeNull();
  });
});
```

- [ ] **Step 6.2: Run tests to verify they fail**

From `packages/app`: `npx vitest run src/components/claude-quota-meter.test.ts --bail=1`
Expected: FAIL (module not found).

- [ ] **Step 6.3: Implement the component**

Create `packages/app/src/components/claude-quota-meter.tsx`. Helpers first (exported, pure), then the component copying `ContextWindowMeter`'s structure:

```tsx
import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { ClaudeQuota } from "@getpaseo/protocol";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Claude brand colors — deliberately NOT theme tokens (see design spec).
export const CLAUDE_ORANGE = "#D97757";
export const CLAUDE_ORANGE_INNER_DARK = "#E5A088";
export const CLAUDE_ORANGE_INNER_LIGHT = "#C97D5E";

const SVG_SIZE = 18;
const CENTER = SVG_SIZE / 2;
const OUTER_RADIUS = 7.5;
const INNER_RADIUS = 4;
const STROKE_WIDTH = 2;
const OUTER_CIRCUMFERENCE = 2 * Math.PI * OUTER_RADIUS;
const INNER_CIRCUMFERENCE = 2 * Math.PI * INNER_RADIUS;
const DESTRUCTIVE_THRESHOLD = 90;

export function resolveRingColor(params: {
  utilization: number;
  ring: "outer" | "inner";
  colorScheme: "dark" | "light";
  destructive: string;
}): string {
  if (params.utilization >= DESTRUCTIVE_THRESHOLD) {
    return params.destructive;
  }
  if (params.ring === "outer") {
    return CLAUDE_ORANGE;
  }
  return params.colorScheme === "dark" ? CLAUDE_ORANGE_INNER_DARK : CLAUDE_ORANGE_INNER_LIGHT;
}

export function formatResetLabel(resetsAt: string | undefined, now: Date): string | null {
  if (!resetsAt) {
    return null;
  }
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) {
    return null;
  }
  if (reset.toDateString() === now.toDateString()) {
    return reset.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const weekday = reset.toLocaleDateString("en-US", { weekday: "short" });
  const time = reset.toLocaleTimeString(undefined, { hour: "numeric" });
  return `${weekday} ${time}`;
}

export function formatUpdatedAgo(fetchedAt: number | null, nowMs: number): string | null {
  if (fetchedAt === null || !Number.isFinite(fetchedAt)) {
    return null;
  }
  const elapsedMs = Math.max(0, nowMs - fetchedAt);
  if (elapsedMs < 60_000) {
    return "Updated just now";
  }
  if (elapsedMs < 3_600_000) {
    return `Updated ${Math.floor(elapsedMs / 60_000)}m ago`;
  }
  return `Updated ${Math.floor(elapsedMs / 3_600_000)}h ago`;
}

function clampFraction(utilization: number): number {
  return Math.max(0, Math.min(100, utilization)) / 100;
}

interface ClaudeQuotaMeterProps {
  quota: ClaudeQuota;
  fetchedAt: number | null;
}

export function ClaudeQuotaMeter({ quota, fetchedAt }: ClaudeQuotaMeterProps) {
  const { theme } = useUnistyles();
  const fiveHour = quota.fiveHour ?? null;
  const sevenDay = quota.sevenDay ?? null;
  if (!fiveHour && !sevenDay) {
    return null;
  }
  const now = new Date();
  const colorScheme = theme.colorScheme;
  const track = theme.colors.surface3;
  const outerColor = fiveHour
    ? resolveRingColor({
        utilization: fiveHour.utilization,
        ring: "outer",
        colorScheme,
        destructive: theme.colors.destructive,
      })
    : track;
  const innerColor = sevenDay
    ? resolveRingColor({
        utilization: sevenDay.utilization,
        ring: "inner",
        colorScheme,
        destructive: theme.colors.destructive,
      })
    : track;
  const outerOffset = fiveHour
    ? OUTER_CIRCUMFERENCE * (1 - clampFraction(fiveHour.utilization))
    : OUTER_CIRCUMFERENCE;
  const innerOffset = sevenDay
    ? INNER_CIRCUMFERENCE * (1 - clampFraction(sevenDay.utilization))
    : INNER_CIRCUMFERENCE;
  const updatedLabel = formatUpdatedAgo(fetchedAt, now.getTime());

  const rows: Array<{ label: string; bucket: { utilization: number; resetsAt?: string } }> = [];
  if (fiveHour) {
    rows.push({ label: "5h session", bucket: fiveHour });
  }
  if (sevenDay) {
    rows.push({ label: "Week (all models)", bucket: sevenDay });
  }
  if (quota.sevenDaySonnet) {
    rows.push({ label: "Week (Sonnet)", bucket: quota.sevenDaySonnet });
  }
  if (quota.sevenDayOpus) {
    rows.push({ label: "Week (Opus)", bucket: quota.sevenDayOpus });
  }

  const accessibilitySummary = rows
    .map((row) => `${row.label} ${Math.round(row.bucket.utilization)}% used`)
    .join(", ");

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={styles.container}
          accessibilityRole="image"
          accessibilityLabel={`Claude usage: ${accessibilitySummary}`}
        >
          <Svg
            width={SVG_SIZE}
            height={SVG_SIZE}
            viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
            style={styles.svg}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Circle cx={CENTER} cy={CENTER} r={OUTER_RADIUS} fill="none" stroke={track} strokeWidth={STROKE_WIDTH} />
            <Circle
              cx={CENTER}
              cy={CENTER}
              r={OUTER_RADIUS}
              fill="none"
              stroke={outerColor}
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
              strokeDasharray={OUTER_CIRCUMFERENCE}
              strokeDashoffset={outerOffset}
            />
            <Circle cx={CENTER} cy={CENTER} r={INNER_RADIUS} fill="none" stroke={track} strokeWidth={STROKE_WIDTH} />
            <Circle
              cx={CENTER}
              cy={CENTER}
              r={INNER_RADIUS}
              fill="none"
              stroke={innerColor}
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
              strokeDasharray={INNER_CIRCUMFERENCE}
              strokeDashoffset={innerOffset}
            />
          </Svg>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltipContent}>
          <Text style={styles.tooltipTitle}>Claude usage</Text>
          {rows.map((row) => {
            const reset = formatResetLabel(row.bucket.resetsAt, now);
            const detail = `${Math.round(row.bucket.utilization)}%${reset ? ` · resets ${reset}` : ""}`;
            return (
              <Text key={row.label} style={styles.tooltipText}>
                {`${row.label} — ${detail}`}
              </Text>
            );
          })}
          {updatedLabel ? <Text style={styles.tooltipDetail}>{updatedLabel}</Text> : null}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  svg: {
    transform: [{ rotate: "-90deg" }],
  },
  tooltipContent: {
    gap: theme.spacing[1],
  },
  tooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  tooltipDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
}));
```

- [ ] **Step 6.4: Run tests to verify they pass**

From `packages/app`: `npx vitest run src/components/claude-quota-meter.test.ts --bail=1`
Expected: PASS (11 tests). Note: the destructive hex in the test is the dark Paseo tint value; if the test imports nothing theme-dependent that's fine — `resolveRingColor` receives `destructive` as a parameter, so the test value is arbitrary.

- [ ] **Step 6.5: Typecheck + lint + commit**

```bash
npm run typecheck && npm run lint -- packages/app/src/components/claude-quota-meter.tsx
git add packages/app/src/components/claude-quota-meter.tsx packages/app/src/components/claude-quota-meter.test.ts
git commit -m "feat(app): add ClaudeQuotaMeter concentric dual-ring component"
```

---

### Task 7: App — composer integration

**Files:**

- Modify: `packages/app/src/composer/index.tsx`
  - `buildAgentStateSelector` (~line 183)
  - `resolveContextWindowPlacement` (~line 211)
  - meter useMemo block (~lines 1486–1502)
  - composer component body where `serverId` is in scope (~line 891)
  - `contextWindowMeterSlot` style (~line 1843)

- [ ] **Step 7.1: Extend the agent state selector with the provider**

In `buildAgentStateSelector` add `provider`:

```ts
return {
  status: agent?.status ?? null,
  provider: agent?.provider ?? null,
  contextWindowMaxTokens: agent?.lastUsage?.contextWindowMaxTokens ?? null,
  contextWindowUsedTokens: agent?.lastUsage?.contextWindowUsedTokens ?? null,
  totalCostUsd: agent?.lastUsage?.totalCostUsd ?? null,
};
```

- [ ] **Step 7.2: Render the quota meter and place both meters together**

Imports at top:

```ts
import { ClaudeQuotaMeter } from "@/components/claude-quota-meter";
import { useClaudeQuota } from "@/hooks/use-claude-quota";
```

In the composer component (where `serverId`/`agentState` are in scope):

```ts
const claudeQuotaState = useClaudeQuota(serverId);
const claudeQuotaMeter = useMemo(
  () =>
    agentState.provider === "claude" && claudeQuotaState ? (
      <ClaudeQuotaMeter quota={claudeQuotaState.quota} fetchedAt={claudeQuotaState.fetchedAt} />
    ) : null,
  [agentState.provider, claudeQuotaState],
);
```

Change `resolveContextWindowPlacement` to accept and combine both meters (quota meter sits to the RIGHT of the context meter, matching the approved mockups):

```ts
function resolveContextWindowPlacement(
  meter: ReactElement | null,
  quotaMeter: ReactElement | null,
  isMobile: boolean,
): { beforeVoiceContent: ReactNode; footerInlineContent: ReactNode } {
  const combined =
    meter || quotaMeter ? (
      <>
        {meter}
        {quotaMeter}
      </>
    ) : null;
  if (isMobile) {
    return { beforeVoiceContent: null, footerInlineContent: combined };
  }
  return {
    beforeVoiceContent: combined ? (
      <View style={styles.contextWindowMeterSlot}>{combined}</View>
    ) : null,
    footerInlineContent: null,
  };
}
```

Update the call site:

```ts
const { beforeVoiceContent, footerInlineContent } = useMemo(
  () => resolveContextWindowPlacement(contextWindowMeter, claudeQuotaMeter, isCompactLayout),
  [contextWindowMeter, claudeQuotaMeter, isCompactLayout],
);
```

Check `styles.contextWindowMeterSlot` (~line 1843): if it doesn't already lay children out in a row, add `flexDirection: "row"`, `alignItems: "center"`, and `gap: theme.spacing[1]`. Check the mobile `footerInlineContent` render site the same way — if both meters render there stacked, wrap in a row `<View>` with the same style.

- [ ] **Step 7.3: Typecheck + lint + commit**

```bash
npm run typecheck && npm run lint -- packages/app/src/composer/index.tsx
git add packages/app/src/composer/index.tsx
git commit -m "feat(app): show Claude quota meter next to context window meter"
```

---

### Task 8: Final verification

- [ ] **Step 8.1: Run the three new test files only**

```bash
cd packages/protocol && npx vitest run src/messages.claude-quota.test.ts --bail=1 && cd ../..
cd packages/server && npx vitest run src/services/claude-quota-service.test.ts --bail=1 && cd ../..
cd packages/app && npx vitest run src/components/claude-quota-meter.test.ts --bail=1 && cd ../..
```

Expected: all PASS.

- [ ] **Step 8.2: Full build + typecheck + lint + format**

```bash
npm run build:server && npm run typecheck && npm run lint && npm run format
```

Expected: clean. If `npm run format` rewrites files, `git add -A && git commit -m "style: format"`.

- [ ] **Step 8.3: Manual smoke check (optional, requires dev environment)**

`npm run dev` + `npm run dev:app`, open a Claude agent, confirm: dual orange ring appears next to the context ring; tooltip shows three rows + "Updated …"; non-Claude agents show no ring. Do NOT touch the production daemon on port 6767.

- [ ] **Step 8.4: Push for CI**

```bash
git push -u origin feat/claude-quota-display
```

Full test suites run on CI, not locally.
