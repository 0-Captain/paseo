import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import equal from "fast-deep-equal";
import type { ClaudeQuota, ClaudeQuotaStatePayload } from "@getpaseo/protocol/messages";

const execFileAsync = promisify(execFile);

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MIN_FETCH_INTERVAL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface ClaudeQuotaSnapshot {
  quota: ClaudeQuota;
  fetchedAt: number;
}

interface ClaudeQuotaLogger {
  warn: (obj: unknown, msg: string) => void;
  debug: (obj: unknown, msg: string) => void;
}

interface ClaudeQuotaServiceOptions {
  baseUrl?: string;
  credentialsPath?: string;
  readKeychainToken?: () => Promise<string | null>;
  minFetchIntervalMs?: number;
  pollIntervalMs?: number;
  logger?: ClaudeQuotaLogger;
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
  private readonly logger: ClaudeQuotaLogger | undefined;

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
    this.lastFetchAt = Date.now();
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
      if (response.status === 401) {
        this.logger?.debug({ status: response.status }, "claude-quota: token rejected");
        this.setSnapshot(null);
        return null;
      }
      if (response.status === 403) {
        this.logger?.warn({ status: response.status }, "claude-quota: token lacks permission");
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
    const changed = !equal(this.snapshot?.quota ?? null, next?.quota ?? null);
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
