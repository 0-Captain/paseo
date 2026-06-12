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
