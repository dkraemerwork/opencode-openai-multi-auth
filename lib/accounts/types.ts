export interface ManagedAccount {
  index: number;
  email?: string;
  userId?: string;
  accountId?: string;
  planType?: string;
  addedAt: number;
  lastUsed?: number;
  parts: {
    refreshToken: string;
  };
  access?: string;
  expires?: number;
  rateLimitResets: Record<string, number>;
  globalRateLimitReset?: number;
  consecutiveFailures: number;
  isRefreshing?: boolean;
  refreshPromise?: Promise<boolean>;
  lastRefreshError?: string;
}

export interface AccountsStorage {
  version: 1;
  accounts: ManagedAccount[];
  activeAccountIndex: number;
  roundRobinCursor?: number;
}

export interface MultiAccountConfig {
  accountSelectionStrategy: "sticky" | "round-robin" | "hybrid";
  debug: boolean;
  quietMode: boolean;
  pidOffsetEnabled: boolean;
  proactiveRefreshThresholdMs: number;
  removeOnInvalidGrant: boolean;
  perModelRateLimits: boolean;
}

export const DEFAULT_MULTI_ACCOUNT_CONFIG: MultiAccountConfig = {
  accountSelectionStrategy: "sticky",
  debug: false,
  quietMode: false,
  pidOffsetEnabled: false,
  proactiveRefreshThresholdMs: 5 * 60 * 1000,
  removeOnInvalidGrant: true,
  perModelRateLimits: true,
};
