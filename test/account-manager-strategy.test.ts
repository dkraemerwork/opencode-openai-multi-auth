import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
 
const originalHome = process.env.HOME;

async function createManager(
  home: string,
  strategy: "sticky" | "round-robin" | "hybrid",
) {
  process.env.HOME = home;
  vi.resetModules();
  const { AccountManager } = await import("../lib/accounts/manager.js");
  return new AccountManager({
    accountSelectionStrategy: strategy,
    quietMode: true,
    debug: false,
  });
}

describe("AccountManager strategy selection", () => {
  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("keeps using the same account in sticky mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "strategy-sticky-"));
    const manager = await createManager(home, "sticky");
    await manager.loadFromDisk();

    await manager.addAccount("a@example.com", "rt-1");
    await manager.addAccount("b@example.com", "rt-2");

    const pick1 = await manager.getNextAvailableAccount();
    const pick2 = await manager.getNextAvailableAccount();
    const pick3 = await manager.getNextAvailableAccount();

    expect(pick1?.index).toBe(0);
    expect(pick2?.index).toBe(0);
    expect(pick3?.index).toBe(0);
  });

  it("rotates accounts on each request in round-robin mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "strategy-rr-"));
    const manager = await createManager(home, "round-robin");
    await manager.loadFromDisk();

    await manager.addAccount("a@example.com", "rt-1");
    await manager.addAccount("b@example.com", "rt-2");
    await manager.addAccount("c@example.com", "rt-3");

    const pick1 = await manager.getNextAvailableAccount();
    const pick2 = await manager.getNextAvailableAccount();
    const pick3 = await manager.getNextAvailableAccount();
    const pick4 = await manager.getNextAvailableAccount();

    expect(pick1?.index).toBe(0);
    expect(pick2?.index).toBe(1);
    expect(pick3?.index).toBe(2);
    expect(pick4?.index).toBe(0);
  });

  it("rotates initial account across sessions in hybrid mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "strategy-hybrid-"));

    const managerSession1 = await createManager(home, "hybrid");
    await managerSession1.loadFromDisk();
    await managerSession1.addAccount("a@example.com", "rt-1");
    await managerSession1.addAccount("b@example.com", "rt-2");
    const session1Pick =
      await managerSession1.getNextAvailableAccountForNewSession();

    const managerSession2 = await createManager(home, "hybrid");
    await managerSession2.loadFromDisk();
    const session2Pick =
      await managerSession2.getNextAvailableAccountForNewSession();

    expect(session1Pick?.index).not.toBeUndefined();
    expect(session2Pick?.index).not.toBeUndefined();
    expect(session2Pick?.index).not.toBe(session1Pick?.index);
  });

  it("switches after rate limit and then stays sticky", async () => {
    const home = mkdtempSync(join(tmpdir(), "strategy-sticky-failover-"));
    const manager = await createManager(home, "sticky");
    await manager.loadFromDisk();

    await manager.addAccount("a@example.com", "rt-1");
    await manager.addAccount("b@example.com", "rt-2");

    const first = await manager.getNextAvailableAccount("gpt-5.2-codex");
    expect(first?.index).toBe(0);

    manager.markRateLimited(first!, 60_000, "gpt-5.2-codex");

    const second = await manager.getNextAvailableAccount("gpt-5.2-codex");
    const third = await manager.getNextAvailableAccount("gpt-5.2-codex");

    expect(second?.index).toBe(1);
    expect(third?.index).toBe(1);
  });

  it("skips rate-limited accounts and keeps round-robin progression", async () => {
    const home = mkdtempSync(join(tmpdir(), "strategy-rr-failover-"));
    const manager = await createManager(home, "round-robin");
    await manager.loadFromDisk();

    await manager.addAccount("a@example.com", "rt-1");
    await manager.addAccount("b@example.com", "rt-2");
    await manager.addAccount("c@example.com", "rt-3");

    const first = await manager.getNextAvailableAccount("gpt-5.2-codex");
    expect(first?.index).toBe(0);

    const accountTwo = manager.getAllAccounts()[1];
    manager.markRateLimited(accountTwo, 60_000, "gpt-5.2-codex");

    const second = await manager.getNextAvailableAccount("gpt-5.2-codex");
    const third = await manager.getNextAvailableAccount("gpt-5.2-codex");

    expect(second?.index).toBe(2);
    expect(third?.index).toBe(0);
  });

  it("stays sticky within a single hybrid session", async () => {
    const home = mkdtempSync(join(tmpdir(), "strategy-hybrid-sticky-"));
    const manager = await createManager(home, "hybrid");
    await manager.loadFromDisk();

    await manager.addAccount("a@example.com", "rt-1");
    await manager.addAccount("b@example.com", "rt-2");

    const first = await manager.getNextAvailableAccount();
    const second = await manager.getNextAvailableAccount();
    const third = await manager.getNextAvailableAccount();

    expect(first?.index).toBeDefined();
    expect(second?.index).toBe(first?.index);
    expect(third?.index).toBe(first?.index);
  });

  it("rotates account selection for new session bindings in the same hybrid process", async () => {
    const home = mkdtempSync(join(tmpdir(), "strategy-hybrid-new-session-"));
    const manager = await createManager(home, "hybrid");
    await manager.loadFromDisk();

    await manager.addAccount("a@example.com", "rt-1");
    await manager.addAccount("b@example.com", "rt-2");
    await manager.addAccount("c@example.com", "rt-3");

    const firstSession = await manager.getNextAvailableAccountForNewSession();
    const secondSession = await manager.getNextAvailableAccountForNewSession();
    const thirdSession = await manager.getNextAvailableAccountForNewSession();
    const fourthSession = await manager.getNextAvailableAccountForNewSession();

    expect(firstSession?.index).toBe(0);
    expect(secondSession?.index).toBe(1);
    expect(thirdSession?.index).toBe(2);
    expect(fourthSession?.index).toBe(0);
  });

  it("persists accounts file with owner-only permissions", async () => {
    const home = mkdtempSync(join(tmpdir(), "strategy-secure-file-"));
    const manager = await createManager(home, "sticky");
    await manager.loadFromDisk();

    await manager.addAccount("secure@example.com", "rt-secure");

    const filePath = join(home, ".config", "opencode", "openai-accounts.json");
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
