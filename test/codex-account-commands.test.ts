import { beforeEach, describe, expect, it, vi } from "vitest";

function createToolContext(sessionID: string) {
  return {
    sessionID,
    messageID: "msg_test",
    agent: "test-agent",
    abort: new AbortController().signal,
  };
}

function requireAuthLoader(plugin: Awaited<ReturnType<typeof import("../index.js").OpenAIAuthPlugin>>) {
  if (!plugin.auth?.loader) {
    throw new Error("Expected plugin auth loader to be defined");
  }
  return plugin.auth.loader;
}

function requireTool(
  plugin: Awaited<ReturnType<typeof import("../index.js").OpenAIAuthPlugin>>,
  name: "codex-account-list" | "codex-switch-account",
) {
  const toolEntry = plugin.tool?.[name];
  if (!toolEntry) {
    throw new Error(`Expected tool ${name} to be defined`);
  }
  return toolEntry;
}

vi.mock("@opencode-ai/plugin", () => ({
  tool: Object.assign((definition: unknown) => definition, {
    schema: {
      string: () => ({
        describe() {
          return this;
        },
      }),
    },
  }),
}));

const renderStatusMock = vi.fn(async () => []);

vi.mock("../lib/codex-status.js", () => ({
  codexStatus: {
    fetchFromBackend: vi.fn(async () => {}),
    renderStatus: renderStatusMock,
  },
}));

vi.mock("../lib/models.js", () => ({
  prefetchModels: vi.fn(async () => {}),
}));

const accounts = [
  {
    index: 0,
    email: "alpha@example.com",
    access: "token-a",
    expires: Date.now() + 60_000,
    accountId: "acct_alpha",
    planType: "Plus",
  },
  {
    index: 1,
    email: "beta@example.com",
    access: "token-b",
    expires: Date.now() + 60_000,
    accountId: "acct_beta",
    planType: "Pro",
  },
];

const sessionBindings = new Map<string, number>();

vi.mock("../lib/accounts/index.js", () => {
  class AccountManager {
    async loadFromDisk() {}
    async importFromOpenCodeAuth() {}
    getAllAccounts() {
      return accounts;
    }
    getAccountCount() {
      return accounts.length;
    }
    getActiveAccount() {
      return accounts[0];
    }
    getAccountByIndex(index: number) {
      return accounts.find((account) => account.index === index) || null;
    }
    findAccountByEmail(email: string) {
      return accounts.find((account) => account.email === email) || null;
    }
    async getNextAvailableAccount() {
      return accounts[0];
    }
    async getNextAvailableAccountForNewSession() {
      return accounts[0];
    }
    async getNextAvailableAccountExcluding() {
      return accounts[0];
    }
    async ensureValidToken() {
      return true;
    }
    markRateLimited() {}
    markRefreshFailed() {}
    async addAccount() {}
  }

  return { AccountManager };
});

vi.mock("../lib/session-bindings.js", () => {
  class SessionBindingStore {
    loadFromDisk() {}
    get(key: string) {
      return sessionBindings.get(key);
    }
    set(key: string, value: number) {
      sessionBindings.set(key, value);
    }
    delete(key: string) {
      sessionBindings.delete(key);
    }
  }

  return { SessionBindingStore };
});

describe("codex account commands", () => {
  beforeEach(() => {
    sessionBindings.clear();
    renderStatusMock.mockClear();
    globalThis.fetch = vi.fn(async () => {
      return new Response('data: {"type":"response.done"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
  });

  it("lists accounts with current session and default markers", async () => {
    const { OpenAIAuthPlugin } = await import("../index.js");
    const plugin = await OpenAIAuthPlugin({
      client: {
        auth: { set: vi.fn() },
        tui: { showToast: vi.fn() },
      },
    } as never);

    const loader = await requireAuthLoader(plugin)(
      async () => ({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      }) as never,
      {} as never,
    );

    await loader.fetch("https://chatgpt.com/backend-api/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        session_id: "opencode-session-1",
      },
      body: JSON.stringify({
        model: "gpt-5.2-codex",
        prompt_cache_key: "ses_prompt_1",
        input: [{ type: "message", role: "user", content: "hello" }],
      }),
    });

    sessionBindings.set("ses_prompt_1", 1);

    const result = await requireTool(plugin, "codex-account-list").execute(
      {},
      createToolContext("opencode-session-1"),
    );

    expect(result).toContain("1. DEFAULT alpha@example.com [Plus]");
    expect(result).toContain("2. CURRENT_SESSION beta@example.com [Pro]");
  });

  it("switches the current session by 1-based index", async () => {
    const { OpenAIAuthPlugin } = await import("../index.js");
    const plugin = await OpenAIAuthPlugin({
      client: {
        auth: { set: vi.fn() },
        tui: { showToast: vi.fn() },
      },
    } as never);

    const loader = await requireAuthLoader(plugin)(
      async () => ({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      }) as never,
      {} as never,
    );

    await loader.fetch("https://chatgpt.com/backend-api/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        session_id: "opencode-session-2",
      },
      body: JSON.stringify({
        model: "gpt-5.2-codex",
        prompt_cache_key: "ses_prompt_2",
        input: [{ type: "message", role: "user", content: "hello" }],
      }),
    });

    const result = await requireTool(plugin, "codex-switch-account").execute(
      { selector: "2" },
      createToolContext("opencode-session-2"),
    );

    expect(result).toContain("Switched current session to account 2");
    expect(sessionBindings.get("ses_prompt_2")).toBe(1);
  });

  it("fails when the current session has no known prompt cache key", async () => {
    const { OpenAIAuthPlugin } = await import("../index.js");
    const plugin = await OpenAIAuthPlugin({
      client: {
        auth: { set: vi.fn() },
        tui: { showToast: vi.fn() },
      },
    } as never);

    const result = await requireTool(plugin, "codex-switch-account").execute(
      { selector: "beta@example.com" },
      createToolContext("unknown-session"),
    );

    expect(result).toContain("Current session has no known prompt_cache_key yet");
  });
});
