import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexStatusManager } from "../lib/codex-status.js";

const baseAccount = {
  index: 0,
  email: "user@example.com",
  accountId: "acc_123",
  planType: "Plus",
  addedAt: 0,
  parts: { refreshToken: "rt_test" },
  rateLimitResets: {},
  consecutiveFailures: 0,
};

describe("CodexStatusManager", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "codex-status-"));
    process.env.OPENCODE_OPENAI_CACHE_DIR = cacheDir;
  });

  it("parses headers and stores snapshot", async () => {
    const manager = new CodexStatusManager();
    await manager.updateFromHeaders(baseAccount as any, {
      "x-codex-primary-used-percent": "45.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "123456789",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "false",
      "x-codex-credits-balance": "15.5",
    });

    const snapshot = await manager.getSnapshot(baseAccount as any);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.primary?.usedPercent).toBe(45.5);
    expect(snapshot?.primary?.windowMinutes).toBe(300);
    expect(snapshot?.credits?.balance).toBe("15.5");
    expect(snapshot?.credits?.unlimited).toBe(false);
  });

  it("clamps usedPercent to 0-100", async () => {
    const manager = new CodexStatusManager();
    await manager.updateFromHeaders(baseAccount as any, {
      "x-codex-primary-used-percent": "150",
      "x-codex-secondary-used-percent": "-50",
    });

    const snapshot = await manager.getSnapshot(baseAccount as any);
    expect(snapshot?.primary?.usedPercent).toBe(100);
    expect(snapshot?.secondary?.usedPercent).toBe(0);
  });

  it("tracks staleness", async () => {
    vi.useFakeTimers();
    try {
      const manager = new CodexStatusManager();
      await manager.updateFromHeaders(baseAccount as any, {
        "x-codex-primary-used-percent": "10",
      });

      expect((await manager.getSnapshot(baseAccount as any))?.isStale).toBe(false);

      vi.advanceTimersByTime(16 * 60 * 1000);
      expect((await manager.getSnapshot(baseAccount as any))?.isStale).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders status bars", async () => {
    const manager = new CodexStatusManager();
    await manager.updateFromHeaders(baseAccount as any, {
      "x-codex-primary-used-percent": "50",
      "x-codex-primary-window-minutes": "0",
      "x-codex-secondary-used-percent": "25",
      "x-codex-credits-unlimited": "true",
    });

    const lines = await manager.renderStatus(baseAccount as any);
    expect(lines.some((line) => line.includes("5h limit:") && line.includes("50% left"))).toBe(true);
    expect(lines.some((line) => line.includes("Weekly limit:") && line.includes("75% left"))).toBe(true);
    expect(lines.some((line) => line.includes("Credits") && line.includes("unlimited"))).toBe(true);
  });

  it("keeps distinct snapshots for minimal accounts", async () => {
    const manager = new CodexStatusManager();
    const accountA = {
      index: 0,
      email: "alpha@example.com",
      addedAt: 0,
      parts: { refreshToken: "" },
      rateLimitResets: {},
      consecutiveFailures: 0,
    };
    const accountB = {
      index: 1,
      email: "beta@example.com",
      addedAt: 0,
      parts: { refreshToken: "" },
      rateLimitResets: {},
      consecutiveFailures: 0,
    };

    await manager.updateFromHeaders(accountA as any, {
      "x-codex-primary-used-percent": "10",
    });
    await manager.updateFromHeaders(accountB as any, {
      "x-codex-primary-used-percent": "20",
    });

    const snapshots = await manager.getAllSnapshots();
    expect(snapshots.length).toBe(2);
  });

  it("uses chatgpt-account-id header when fetching backend usage", async () => {
    const manager = new CodexStatusManager();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: 12,
                limit_window_seconds: 18000,
                reset_at: 1771264056,
              },
              secondary_window: {
                used_percent: 5,
                limit_window_seconds: 604800,
                reset_at: 1771500294,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    try {
      await manager.fetchFromBackend(baseAccount as any, "a.b.c");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0];
      const headers = new Headers((init as RequestInit).headers);
      expect(headers.get("chatgpt-account-id")).toBe(baseAccount.accountId);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("renders 5h and weekly limits from team usage response", async () => {
    const manager = new CodexStatusManager();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            plan_type: "team",
            rate_limit: {
              primary_window: {
                used_percent: 14,
                limit_window_seconds: 18000,
                reset_at: 1771264056,
              },
              secondary_window: {
                used_percent: 22,
                limit_window_seconds: 604800,
                reset_at: 1771500294,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    try {
      await manager.fetchFromBackend(baseAccount as any, "a.b.c");
      const lines = await manager.renderStatus(baseAccount as any);
      expect(lines.some((line) => line.includes("Plan:") && line.includes("Backend team"))).toBe(true);
      expect(lines.some((line) => line.includes("5h limit:"))).toBe(true);
      expect(lines.some((line) => line.includes("Weekly limit:"))).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("shows oauth and backend plan mismatch", async () => {
    const manager = new CodexStatusManager();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            plan_type: "free",
            rate_limit: {
              primary_window: {
                used_percent: 0,
                limit_window_seconds: 604800,
                reset_at: 1771856509,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    try {
      await manager.fetchFromBackend(baseAccount as any, "a.b.c");
      const lines = await manager.renderStatus(baseAccount as any);
      expect(
        lines.some(
          (line) =>
            line.includes("Plan:") &&
            line.includes("Backend free"),
        ),
      ).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
