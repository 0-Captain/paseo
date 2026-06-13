import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClaudeQuota } from "@getpaseo/protocol/messages";
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
  return ["claude-quota", serverId] as const;
}

export function useClaudeQuota(serverId: string | null): ClaudeQuotaState | null {
  const { t } = useTranslation();
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
        throw new Error(t("workspace.terminal.hostDisconnected"));
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
