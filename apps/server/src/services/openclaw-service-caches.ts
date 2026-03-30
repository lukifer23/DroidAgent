import type {
  ChannelConfigSummary,
  ChannelStatus,
  MemoryStatus,
} from "@droidagent/shared";

import { TtlCache } from "../lib/ttl-cache.js";

export function createOpenClawServiceCaches(params: {
  channelStatusTtlMs: number;
  memoryStatusTtlMs: number;
}) {
  const channelStatusesCache = new TtlCache<{
    statuses: ChannelStatus[];
    config: ChannelConfigSummary;
  }>(params.channelStatusTtlMs);
  const memoryStatusCache = new TtlCache<MemoryStatus>(params.memoryStatusTtlMs);

  return {
    channelStatusesCache,
    memoryStatusCache,
    invalidateChannelStatusCache(): void {
      channelStatusesCache.invalidate();
    },
    invalidateMemoryStatusCache(): void {
      memoryStatusCache.invalidate();
    },
    invalidateAll(): void {
      channelStatusesCache.invalidate();
      memoryStatusCache.invalidate();
    },
  };
}
