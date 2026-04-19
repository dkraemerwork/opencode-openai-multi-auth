import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;

function createAccessToken(input: {
  accountId: string;
  userId: string;
  email?: string;
  planType?: string;
  tokenId?: string;
}) {
  const payload = Buffer.from(
    JSON.stringify({
      jti: input.tokenId,
      "https://api.openai.com/auth": {
        chatgpt_account_id: input.accountId,
        chatgpt_user_id: input.userId,
        chatgpt_plan_type: input.planType ?? "plus",
      },
      "https://api.openai.com/profile": input.email
        ? {
            email: input.email,
          }
        : undefined,
    }),
  ).toString("base64url");

  return `header.${payload}.signature`;
}

function writeOpenCodeAuth(
  home: string,
  input: { access: string; refresh: string; expires: number },
) {
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      openai: {
        type: "oauth",
        access: input.access,
        refresh: input.refresh,
        expires: input.expires,
      },
    }),
  );
}

async function createManager(
  home: string,
  refreshMock?: ReturnType<typeof vi.fn>,
) {
  process.env.HOME = home;
  vi.resetModules();

  if (refreshMock) {
    vi.doMock("../lib/auth/auth.js", async () => {
      const actual = await vi.importActual<typeof import("../lib/auth/auth.js")>(
        "../lib/auth/auth.js",
      );
      return {
        ...actual,
        refreshAccessToken: refreshMock,
      };
    });
  }

  const { AccountManager } = await import("../lib/accounts/manager.js");
  return new AccountManager({ quietMode: true, debug: false });
}

describe("AccountManager OpenCode auth sync", () => {
  afterEach(() => {
    process.env.HOME = originalHome;
    vi.resetModules();
    vi.unmock("../lib/auth/auth.js");
    vi.clearAllMocks();
  });

  it("reuses addAccount identity dedupe when OpenCode refresh token rotates", async () => {
    const home = mkdtempSync(join(tmpdir(), "manager-import-rotation-"));
    const manager = await createManager(home);
    await manager.loadFromDisk();

    const oldAccess = createAccessToken({
      accountId: "acct-1",
      userId: "user-1",
      email: "sync@example.com",
      tokenId: "old-token",
    });
    const newAccess = createAccessToken({
      accountId: "acct-1",
      userId: "user-1",
      email: "sync@example.com",
      tokenId: "new-token",
    });

    await manager.addAccount(undefined, "rt-old", oldAccess, Date.now() + 60_000);
    writeOpenCodeAuth(home, {
      access: newAccess,
      refresh: "rt-new",
      expires: Date.now() + 120_000,
    });

    await manager.importFromOpenCodeAuth();

    const accounts = manager.getAllAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].parts.refreshToken).toBe("rt-new");
    expect(accounts[0].access).toBe(newAccess);
  });

  it("reimports OpenCode tokens for the same account before refreshing", async () => {
    const home = mkdtempSync(join(tmpdir(), "manager-reimport-before-refresh-"));
    const refreshMock = vi.fn().mockResolvedValue({ type: "failed" });
    const manager = await createManager(home, refreshMock);
    await manager.loadFromDisk();

    const staleAccess = createAccessToken({
      accountId: "acct-1",
      userId: "user-1",
      email: "sync@example.com",
      tokenId: "stale-token",
    });
    const freshAccess = createAccessToken({
      accountId: "acct-1",
      userId: "user-1",
      email: "sync@example.com",
      tokenId: "fresh-token",
    });

    const account = await manager.addAccount(undefined, "rt-stale", staleAccess, Date.now() - 1_000);
    writeOpenCodeAuth(home, {
      access: freshAccess,
      refresh: "rt-fresh",
      expires: Date.now() + 60_000,
    });

    const ok = await manager.ensureValidToken(account);

    expect(ok).toBe(true);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(account.parts.refreshToken).toBe("rt-fresh");
    expect(account.access).toBe(freshAccess);
  });

  it("skips plugin refresh when OpenCode already has the same account tokens", async () => {
    const home = mkdtempSync(join(tmpdir(), "manager-same-token-no-refresh-"));
    const refreshMock = vi.fn().mockResolvedValue({ type: "failed" });
    const manager = await createManager(home, refreshMock);
    await manager.loadFromDisk();

    const sharedAccess = createAccessToken({
      accountId: "acct-1",
      userId: "user-1",
      email: "sync@example.com",
      tokenId: "shared-token",
    });

    const account = await manager.addAccount(undefined, "rt-shared", sharedAccess, Date.now() - 1_000);
    writeOpenCodeAuth(home, {
      access: sharedAccess,
      refresh: "rt-shared",
      expires: Date.now() + 60_000,
    });

    const ok = await manager.ensureValidToken(account);

    expect(ok).toBe(true);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(account.parts.refreshToken).toBe("rt-shared");
    expect(account.access).toBe(sharedAccess);
    expect(account.expires).toBeGreaterThan(Date.now());
  });

  it("treats matching user ids as the same account when OpenCode snapshot lacks account id", async () => {
    const home = mkdtempSync(join(tmpdir(), "manager-userid-fallback-"));
    const refreshMock = vi.fn().mockResolvedValue({ type: "failed" });
    const manager = await createManager(home, refreshMock);
    await manager.loadFromDisk();

    const localAccess = createAccessToken({
      accountId: "acct-1",
      userId: "user-1",
      email: "sync@example.com",
      tokenId: "local-token",
    });
    const partialPayload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_user_id: "user-1",
          chatgpt_plan_type: "plus",
        },
      }),
    ).toString("base64url");
    const partialAccess = `header.${partialPayload}.signature`;

    const account = await manager.addAccount(undefined, "rt-local", localAccess, Date.now() - 1_000);
    writeOpenCodeAuth(home, {
      access: partialAccess,
      refresh: "rt-partial",
      expires: Date.now() + 60_000,
    });

    const ok = await manager.ensureValidToken(account);

    expect(ok).toBe(true);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(account.parts.refreshToken).toBe("rt-partial");
    expect(account.access).toBe(partialAccess);
  });

  it("falls back to plugin refresh for a different OpenCode account", async () => {
    const home = mkdtempSync(join(tmpdir(), "manager-different-account-refresh-"));
    const refreshedAccess = createAccessToken({
      accountId: "acct-1",
      userId: "user-1",
      email: "local@example.com",
      tokenId: "refreshed-token",
    });
    const refreshMock = vi.fn().mockResolvedValue({
      type: "success",
      access: refreshedAccess,
      refresh: "rt-refreshed",
      expires: Date.now() + 90_000,
    });
    const manager = await createManager(home, refreshMock);
    await manager.loadFromDisk();

    const localAccess = createAccessToken({
      accountId: "acct-1",
      userId: "user-1",
      email: "local@example.com",
      tokenId: "local-token",
    });
    const otherAccess = createAccessToken({
      accountId: "acct-2",
      userId: "user-2",
      email: "other@example.com",
      tokenId: "other-token",
    });

    const account = await manager.addAccount(undefined, "rt-local", localAccess, Date.now() - 1_000);
    writeOpenCodeAuth(home, {
      access: otherAccess,
      refresh: "rt-other",
      expires: Date.now() + 60_000,
    });

    const ok = await manager.ensureValidToken(account);

    expect(ok).toBe(true);
    expect(refreshMock).toHaveBeenCalledOnce();
    expect(refreshMock).toHaveBeenCalledWith("rt-local");
    expect(account.parts.refreshToken).toBe("rt-refreshed");
    expect(account.access).toBe(refreshedAccess);
  });
});
