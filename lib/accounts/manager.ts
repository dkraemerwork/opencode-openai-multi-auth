import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { decodeJWT, refreshAccessToken } from "../auth/auth.js";
import type {
  ManagedAccount,
  AccountsStorage,
  MultiAccountConfig,
} from "./types.js";
import { DEFAULT_MULTI_ACCOUNT_CONFIG } from "./types.js";

const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const ACCOUNTS_FILE = join(
  homedir(),
  ".config",
  "opencode",
  "openai-accounts.json",
);
const OPENCODE_AUTH_FILE = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "auth.json",
);

export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private activeIndex = 0;
  private roundRobinCursor = 0;
  private strategyInitialized = false;
  private config: MultiAccountConfig;

  constructor(config: Partial<MultiAccountConfig> = {}) {
    this.config = { ...DEFAULT_MULTI_ACCOUNT_CONFIG, ...config };
  }

  async loadFromDisk(): Promise<void> {
    if (!existsSync(ACCOUNTS_FILE)) return;

    try {
      const data = JSON.parse(
        readFileSync(ACCOUNTS_FILE, "utf-8"),
      ) as AccountsStorage;
      if (data.version === 1 && Array.isArray(data.accounts)) {
        this.accounts = data.accounts;
        this.activeIndex = data.activeAccountIndex || 0;
        this.strategyInitialized = false;
      }
    } catch {
      this.accounts = [];
      this.activeIndex = 0;
      this.roundRobinCursor = 0;
      this.strategyInitialized = false;
    }
  }

  async saveToDisk(): Promise<void> {
    const dir = dirname(ACCOUNTS_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const data: AccountsStorage = {
      version: 1,
      accounts: this.accounts,
      activeAccountIndex: this.activeIndex,
    };
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), "utf-8");
  }

  async importFromOpenCodeAuth(): Promise<void> {
    if (!existsSync(OPENCODE_AUTH_FILE)) return;

    try {
      const authData = JSON.parse(readFileSync(OPENCODE_AUTH_FILE, "utf-8"));
      const openaiAuth = authData?.openai;

      if (openaiAuth?.type === "oauth" && openaiAuth?.refresh) {
        const existingAccount = this.accounts.find(
          (a) => a.parts.refreshToken === openaiAuth.refresh,
        );

        if (!existingAccount) {
          await this.addAccount(
            undefined,
            openaiAuth.refresh,
            openaiAuth.access,
            openaiAuth.expires,
          );
        }
      }
    } catch {}
  }

  async addAccount(
    email: string | undefined,
    refreshToken: string,
    accessToken?: string,
    expires?: number,
  ): Promise<ManagedAccount> {
    let accountId: string | undefined;
    let userId: string | undefined;
    let extractedEmail = email;
    let planType: string | undefined;

    if (accessToken) {
      const decoded = decodeJWT(accessToken);
      if (decoded) {
        const authClaims = decoded[JWT_CLAIM_PATH] as
          | Record<string, unknown>
          | undefined;
        accountId = authClaims?.chatgpt_account_id as string | undefined;
        userId = authClaims?.chatgpt_user_id as string | undefined;
        planType = authClaims?.chatgpt_plan_type as string | undefined;

        const profile = decoded["https://api.openai.com/profile"] as
          | Record<string, unknown>
          | undefined;
        if (!extractedEmail && profile?.email) {
          extractedEmail = profile.email as string;
        }
      }
    }

    // Deduplicate by userId + accountId (unique per user per workspace) or fallback to refreshToken
    const existingIndex = this.accounts.findIndex((a) => {
      if (userId && a.userId) {
        return a.userId === userId && a.accountId === accountId;
      }
      return a.parts.refreshToken === refreshToken;
    });

    if (existingIndex >= 0) {
      const existing = this.accounts[existingIndex];
      if (accessToken) existing.access = accessToken;
      if (refreshToken) existing.parts.refreshToken = refreshToken;
      if (expires) existing.expires = expires;
      if (userId) existing.userId = userId;
      if (accountId) existing.accountId = accountId;
      if (planType) existing.planType = planType;
      if (extractedEmail) existing.email = extractedEmail;
      existing.consecutiveFailures = 0;
      await this.saveToDisk();

      if (!this.config.quietMode) {
        console.log(
          `[openai-multi-auth] Updated account ${extractedEmail || existing.index}`,
        );
      }
      this.strategyInitialized = false;
      return existing;
    }

    const account: ManagedAccount = {
      index: this.accounts.length,
      email: extractedEmail,
      userId,
      planType,
      accountId,
      addedAt: Date.now(),
      parts: { refreshToken },
      access: accessToken,
      expires,
      rateLimitResets: {},
      consecutiveFailures: 0,
    };

    this.accounts.push(account);
    this.strategyInitialized = false;
    await this.saveToDisk();

    if (!this.config.quietMode) {
      console.log(
        `[openai-multi-auth] Added account ${extractedEmail || account.index}`,
      );
    }

    return account;
  }

  getAllAccounts(): ManagedAccount[] {
    return this.accounts;
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  async getNextAvailableAccount(
    model?: string,
  ): Promise<ManagedAccount | null> {
    if (this.accounts.length === 0) return null;

    await this.initializeStrategyState();

    const now = Date.now();
    const startIndex =
      this.config.accountSelectionStrategy === "round-robin"
        ? this.roundRobinCursor
        : this.activeIndex;
    let attempts = 0;

    while (attempts < this.accounts.length) {
      const index = (startIndex + attempts) % this.accounts.length;
      const account = this.accounts[index];

      if (this.isAccountAvailable(account, model, now)) {
        this.activeIndex = index;
        if (this.config.accountSelectionStrategy === "round-robin") {
          this.roundRobinCursor = (index + 1) % this.accounts.length;
        }
        account.lastUsed = now;
        return account;
      }

      attempts++;
    }

    const fallback = this.getLeastRateLimitedAccount(model);
    if (fallback) {
      this.activeIndex = fallback.index;
      if (this.config.accountSelectionStrategy === "round-robin") {
        this.roundRobinCursor = (fallback.index + 1) % this.accounts.length;
      }
      fallback.lastUsed = now;
    }
    return fallback;
  }

  private normalizeIndex(index: number): number {
    if (this.accounts.length === 0) return 0;
    if (index < 0 || index >= this.accounts.length) return 0;
    return index;
  }

  private async initializeStrategyState(): Promise<void> {
    if (this.strategyInitialized) return;

    if (this.accounts.length === 0) {
      this.activeIndex = 0;
      this.roundRobinCursor = 0;
      this.strategyInitialized = true;
      return;
    }

    this.activeIndex = this.normalizeIndex(this.activeIndex);

    if (
      this.config.accountSelectionStrategy === "hybrid" &&
      this.accounts.length > 1
    ) {
      this.activeIndex = (this.activeIndex + 1) % this.accounts.length;
      await this.saveToDisk();
    }

    if (this.config.pidOffsetEnabled && this.accounts.length > 1) {
      const pidOffset = Math.abs(process.pid) % this.accounts.length;
      this.activeIndex = (this.activeIndex + pidOffset) % this.accounts.length;
    }

    this.roundRobinCursor = this.activeIndex;
    this.strategyInitialized = true;
  }

  private isAccountAvailable(
    account: ManagedAccount,
    model: string | undefined,
    now: number,
  ): boolean {
    if (account.consecutiveFailures >= 3) return false;

    if (account.globalRateLimitReset && account.globalRateLimitReset > now) {
      return false;
    }

    if (model && this.config.perModelRateLimits) {
      const modelReset = account.rateLimitResets[model];
      if (modelReset && modelReset > now) {
        return false;
      }
    }

    return true;
  }

  private getLeastRateLimitedAccount(model?: string): ManagedAccount | null {
    if (this.accounts.length === 0) return null;

    const now = Date.now();
    let bestAccount: ManagedAccount | null = null;
    let earliestReset = Infinity;

    for (const account of this.accounts) {
      if (account.consecutiveFailures >= 3) continue;

      let resetTime = account.globalRateLimitReset || 0;
      if (model && this.config.perModelRateLimits) {
        const modelReset = account.rateLimitResets[model] || 0;
        resetTime = Math.max(resetTime, modelReset);
      }

      if (resetTime < earliestReset) {
        earliestReset = resetTime;
        bestAccount = account;
      }
    }

    return bestAccount;
  }

  markRateLimited(
    account: ManagedAccount,
    retryAfterMs: number,
    model?: string,
  ): void {
    const resetTime = Date.now() + retryAfterMs;

    if (model && this.config.perModelRateLimits) {
      account.rateLimitResets[model] = resetTime;
    } else {
      account.globalRateLimitReset = resetTime;
    }

    if (this.config.debug) {
      const identifier = account.email || `account-${account.index}`;
      console.log(
        `[openai-multi-auth] ${identifier} rate limited until ${new Date(resetTime).toISOString()}`,
      );
    }
  }

  markRefreshFailed(account: ManagedAccount, error: string): void {
    account.consecutiveFailures++;
    account.lastRefreshError = error;
    account.isRefreshing = false;

    if (this.config.removeOnInvalidGrant && error.includes("invalid_grant")) {
      this.removeAccount(account);
    }
  }

  removeAccount(account: ManagedAccount): void {
    const index = this.accounts.findIndex((a) => a.index === account.index);
    if (index >= 0) {
      this.accounts.splice(index, 1);
      this.accounts.forEach((a, i) => (a.index = i));

      if (this.activeIndex >= this.accounts.length) {
        this.activeIndex = Math.max(0, this.accounts.length - 1);
      }
      this.roundRobinCursor = this.activeIndex;
      this.strategyInitialized = false;

      this.saveToDisk();

      if (!this.config.quietMode) {
        console.log(
          `[openai-multi-auth] Removed account ${account.email || account.index}`,
        );
      }
    }
  }

  async updateAccountTokens(
    account: ManagedAccount,
    accessToken: string,
    refreshToken: string,
    expires: number,
  ): Promise<void> {
    account.access = accessToken;
    account.parts.refreshToken = refreshToken;
    account.expires = expires;
    account.consecutiveFailures = 0;
    account.isRefreshing = false;
    account.lastRefreshError = undefined;

    const decoded = decodeJWT(accessToken);
    if (decoded) {
      const authClaims = decoded[JWT_CLAIM_PATH] as
        | Record<string, unknown>
        | undefined;
      if (authClaims?.chatgpt_account_id) {
        account.accountId = authClaims.chatgpt_account_id as string;
      }
      if (authClaims?.chatgpt_user_id) {
        account.userId = authClaims.chatgpt_user_id as string;
      }
      if (authClaims?.chatgpt_plan_type) {
        account.planType = authClaims.chatgpt_plan_type as string;
      }
    }

    await this.saveToDisk();
  }

  async ensureValidToken(account: ManagedAccount): Promise<boolean> {
    if (
      !account.expires ||
      account.expires > Date.now() + this.config.proactiveRefreshThresholdMs
    ) {
      return true;
    }

    if (account.isRefreshing) {
      return !!account.access;
    }

    account.isRefreshing = true;

    try {
      const result = await refreshAccessToken(account.parts.refreshToken);

      if (result.type === "success") {
        await this.updateAccountTokens(
          account,
          result.access,
          result.refresh,
          result.expires,
        );
        return true;
      }

      this.markRefreshFailed(account, "Token refresh failed");
      return false;
    } catch (err) {
      this.markRefreshFailed(account, String(err));
      return false;
    }
  }

  getActiveAccount(): ManagedAccount | null {
    if (this.accounts.length === 0) return null;
    return this.accounts[this.activeIndex] || this.accounts[0];
  }
}
