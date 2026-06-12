# Claude Subscription Quota Display — Design

Date: 2026-06-12
Status: Approved pending user spec review

## Motivation

Claude Code subscription (Pro/Max) usage is limited by a 5-hour rolling session
quota and weekly quotas. Paseo currently shows context-window usage per agent
but has no view of account-level subscription quota. Users have to run `/usage`
inside Claude Code to see it. This feature surfaces the quota directly in the
Paseo composer.

## Data source (verified 2026-06-12)

`GET https://api.anthropic.com/api/oauth/usage` with:

- `Authorization: Bearer <accessToken>` — the Claude Code subscription OAuth
  token. macOS: Keychain item `Claude Code-credentials`; Linux:
  `~/.claude/.credentials.json`. JSON path: `claudeAiOauth.accessToken`.
- `anthropic-beta: oauth-2025-04-20` — required.

Observed response shape (HTTP 200):

```json
{
  "five_hour": { "utilization": 66.0, "resets_at": "2026-06-12T08:00:00+00:00" },
  "seven_day": { "utilization": 53.0, "resets_at": "2026-06-17T00:00:00+00:00" },
  "seven_day_sonnet": { "utilization": 6.0, "resets_at": "2026-06-17T00:00:00+00:00" },
  "seven_day_opus": null,
  "extra_usage": { "is_enabled": false }
}
```

This is an undocumented internal API. Every field must be treated as optional
and subject to change. The response also contains experimental fields we
ignore.

## Visibility rules

The quota component renders in the composer, immediately next to the existing
context-window meter, only when ALL of:

1. The active agent's provider is `claude`.
2. The agent's host reports `server_info.features.claudeQuota === true`
   (old daemons: hidden automatically).
3. The daemon has successfully fetched quota data (subscription OAuth
   credentials exist on the host).

API-key users, missing credentials, and fetch failures all result in the
component silently not rendering. No error states, no degraded fallback —
per the repo's feature-contract rules.

## Daemon: ClaudeQuotaService

New file: `packages/server/src/services/claude-quota-service.ts`.

- **Credential reading:** macOS — `security find-generic-password -s
"Claude Code-credentials" -w`; fallback (all platforms) —
  `~/.claude/.credentials.json`. Extract `claudeAiOauth.accessToken`. The
  token never appears in logs or protocol messages.
- **Fetch:** `GET <baseUrl>/api/oauth/usage` with the two headers above,
  10s timeout. `baseUrl` injectable for tests (default
  `https://api.anthropic.com`).
- **Refresh triggers:**
  1. Claude-provider `turn_completed` events, debounced — minimum 30s
     between fetches.
  2. Periodic fallback every 5 minutes, paused while no clients are
     connected (other devices may consume quota, so idle refresh matters
     only when someone is looking).
  3. First client request when no cached value exists.
- **Error handling:** HTTP 401 (token expired/revoked) → mark unavailable
  and retry on the next trigger; Claude Code refreshes the token itself and
  writes it back, so no refresh flow is implemented here. Network errors →
  keep last good data with its `fetchedAt` timestamp. Parse failures on
  individual fields → drop the field, keep the rest.
- On successful fetch with changed data: broadcast `usage.claude.quota_updated`
  to all connected clients.

## Protocol

New RPC pair (per `docs/rpc-namespacing.md`):

- `usage.claude.get_quota.request` — `{ requestId }`
- `usage.claude.get_quota.response` — payload
  `{ requestId, available: boolean, quota?, fetchedAt? }`

One-way broadcast (no request counterpart; noted in code near the schema):

- `usage.claude.quota_updated` — payload `{ available, quota?, fetchedAt? }`

`ClaudeQuotaSchema` — all fields `.optional()` (backward/forward compatible;
the upstream API is undocumented):

```ts
{
  fiveHour?:       { utilization: number; resetsAt?: string },
  sevenDay?:       { utilization: number; resetsAt?: string },
  sevenDaySonnet?: { utilization: number; resetsAt?: string },
  sevenDayOpus?:   { utilization: number; resetsAt?: string },
}
```

Capability flag in `ServerInfoStatusPayloadSchema.features`:

```ts
// COMPAT(claudeQuota): added in v0.1.X, drop the gate when floor >= v0.1.X
claudeQuota: z.boolean().optional(),
// ("v0.1.X" is filled with the actual next release version at implementation time)
```

## App UI — concentric dual ring (option B)

New component: `packages/app/src/components/claude-quota-meter.tsx`.
New hook: `packages/app/src/hooks/use-claude-quota.ts`.

**Form (user-selected from mockups):** a single 18px SVG icon containing two
concentric rings, rendered next to the context-window meter in the composer's
before-voice slot:

- Outer ring (r 7.5, stroke 2): 5-hour session utilization, Claude brand
  orange `#D97757`.
- Inner ring (r 4, stroke 2): weekly (all models) utilization, lighter
  orange — `#E5A088` on dark themes, `#C97D5E` on light themes.
- Track color: `theme.colors.surface3` (matches the context meter's track).
- Drawing approach copied from `ContextWindowMeter` (rotated SVG circles
  with `strokeDasharray`/`strokeDashoffset`).

**Threshold color:** when a bucket reaches ≥90% utilization its ring's
progress stroke switches to `theme.colors.destructive`. There is
deliberately no amber middle tier (unlike the context meter): an amber outer
ring would be too easy to confuse with the light-orange inner ring. Orange
IS the identity color here; red is the only alert state.

**Tooltip** (shared `Tooltip` primitive, `enabledOnDesktop` +
`enabledOnMobile`, same as the context meter):

- Title: `Claude usage`
- Row: `5h session — 66% · resets 4:00 PM` (reset times formatted in the
  device's local timezone; hour-level precision)
- Row: `Week (all models) — 53% · resets Tue 8 AM`
- Row: `Week (Sonnet) — 6% · resets Tue 8 AM` — only when the bucket is
  present; same rule for an Opus bucket.
- Footer (muted): `Updated 2m ago` from `fetchedAt`.

**Brand color:** `#D97757` and its light variants are defined as constants
in the component file; they are Claude brand colors, not theme-tint
colors, so they do not go into the theme palette.

**Data flow:** `use-claude-quota` lives against the host connection: on
connect, if `features.claudeQuota`, send `usage.claude.get_quota.request`
once, then listen for `usage.claude.quota_updated` pushes. Quota state is
stored per host. The composer renders `ClaudeQuotaMeter` only when the
active agent's provider is `claude` and that agent's host has quota data.

## Data flow overview

```
Claude turn_completed ──┐
5-min fallback poll ────┼─→ ClaudeQuotaService (debounce 30s, cache, fetch)
first client request ───┘        │ on change
                                 ▼
                    broadcast usage.claude.quota_updated
                                 │
                                 ▼
        use-claude-quota (per host) → ClaudeQuotaMeter (composer)
```

## Testing

Per `docs/testing.md` (real dependencies; external HTTP via local stub):

- **Service unit tests** (`claude-quota-service.test.ts`): response parsing
  against the verified real-shape sample; unknown/extra fields tolerated;
  credential fallback order (temp credentials file; injectable keychain
  command); debounce and cache behavior with an injected clock; 401 and
  network-error paths against a local HTTP stub server.
- **Protocol tests:** schema round-trip; forward-compat (payload with
  unknown fields parses; missing buckets parse).
- **Component tests:** hidden when no data / wrong provider / feature off;
  ring geometry from utilization values; ≥90% destructive color; tooltip
  rows including conditional Sonnet/Opus rows.
- Run only the new test files (`npx vitest run <file> --bail=1`); full
  suites go to CI.

## Client coverage

Desktop (Electron), web (browser), and mobile (iOS/Android) share the same
Expo composer component, so one `ClaudeQuotaMeter` covers all three GUI
clients. Interaction differs only via the existing `Tooltip` primitive:
hover on web/desktop, press on mobile. Mockups for all three were reviewed
and approved (concentric dual ring, Claude brand orange).

## Out of scope

- CLI quota display (`paseo daemon status` integration) — explicitly
  declined during design review.
- OAuth token refresh (Claude Code owns the credential lifecycle).
- Host-level quota panel (the service/protocol design supports adding one
  later).
- `extra_usage` (paid overage credits) display.
- Quota display for other providers.
