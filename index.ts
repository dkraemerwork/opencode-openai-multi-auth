import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import {
  createAuthorizationFlow,
  decodeJWT,
  exchangeAuthorizationCode,
  parseAuthorizationInput,
  REDIRECT_URI,
} from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import { getCodexMode, loadPluginConfig } from "./lib/config.js";
import {
  AUTH_LABELS,
  CODEX_BASE_URL,
  DUMMY_API_KEY,
  ERROR_MESSAGES,
  JWT_CLAIM_PATH,
  LOG_STAGES,
  PROVIDER_ID,
  HTTP_STATUS,
} from "./lib/constants.js";
import { logRequest, logDebug } from "./lib/logger.js";
import {
  createCodexHeaders,
  extractRequestUrl,
  handleErrorResponse,
  handleSuccessResponse,
  rewriteUrlForCodex,
  transformRequestForCodex,
} from "./lib/request/fetch-helpers.js";
import type { UserConfig } from "./lib/types.js";
import { AccountManager } from "./lib/accounts/index.js";
import type { ManagedAccount } from "./lib/accounts/index.js";
import { codexStatus } from "./lib/codex-status.js";

function extractModelFromBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    return parsed?.model;
  } catch {
    return undefined;
  }
}

let lastToastAccountIndex: number | null = null;
let lastToastTime = 0;
const TOAST_DEBOUNCE_MS = 5000;

export const OpenAIAuthPlugin: Plugin = async ({ client }: PluginInput) => {
  const quietMode = process.env.OPENCODE_OPENAI_QUIET === "1";
  const debugMode = process.env.OPENCODE_OPENAI_DEBUG === "1";

  const showRateLimitToast = async (
    account: ManagedAccount,
    retryAfterMs: number,
  ) => {
    if (quietMode) return;
    const accountLabel = account.email || `Account ${account.index + 1}`;
    const retryMinutes = Math.ceil(retryAfterMs / 60000);
    const retryText =
      retryMinutes >= 60
        ? `${Math.ceil(retryMinutes / 60)}h`
        : `${retryMinutes}m`;
    try {
      await client.tui.showToast({
        body: {
          message: `${accountLabel} rate limited. Retry in ${retryText}.`,
          variant: "warning",
        },
      });
    } catch {}
  };

  const showAccountSwitchToast = async (
    fromAccount: ManagedAccount,
    toAccount: ManagedAccount,
  ) => {
    if (quietMode) return;
    const fromLabel = fromAccount.email || `Account ${fromAccount.index + 1}`;
    const toLabel = toAccount.email || `Account ${toAccount.index + 1}`;
    const toPlanLabel = toAccount.planType ? ` [${toAccount.planType}]` : "";
    try {
      await client.tui.showToast({
        body: {
          message: `Switching ${fromLabel} → ${toLabel}${toPlanLabel}`,
          variant: "info",
        },
      });
    } catch {}
  };

  const showAccountToast = async (
    account: ManagedAccount,
    totalAccounts: number,
  ) => {
    if (quietMode) return;
    if (totalAccounts <= 1) return;

    const now = Date.now();
    if (
      lastToastAccountIndex === account.index &&
      now - lastToastTime < TOAST_DEBOUNCE_MS
    ) {
      return;
    }

    lastToastAccountIndex = account.index;
    lastToastTime = now;

    const accountLabel = account.email || `Account ${account.index + 1}`;
    const planLabel = account.planType ? ` [${account.planType}]` : "";
    try {
      await client.tui.showToast({
        body: {
          message: `Using ${accountLabel}${planLabel} (${account.index + 1}/${totalAccounts})`,
          variant: "info",
        },
      });
    } catch {}
  };

  const accountManager = new AccountManager({
    accountSelectionStrategy:
      (process.env.OPENCODE_OPENAI_STRATEGY as
        | "sticky"
        | "round-robin"
        | "hybrid") || "sticky",
    debug: process.env.OPENCODE_OPENAI_DEBUG === "1",
    quietMode: process.env.OPENCODE_OPENAI_QUIET === "1",
    pidOffsetEnabled: process.env.OPENCODE_OPENAI_PID_OFFSET === "1",
  });

  await accountManager.loadFromDisk();
  await accountManager.importFromOpenCodeAuth();

  const buildManualOAuthFlow = (pkce: { verifier: string }, url: string) => ({
    url,
    method: "code" as const,
    instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
    callback: async (input: string) => {
      const parsed = parseAuthorizationInput(input);
      if (!parsed.code) {
        return { type: "failed" as const };
      }
      const tokens = await exchangeAuthorizationCode(
        parsed.code,
        pkce.verifier,
        REDIRECT_URI,
      );

      if (tokens?.type === "success") {
        const decoded = decodeJWT(tokens.access);
        const profile = decoded?.["https://api.openai.com/profile"] as
          | Record<string, unknown>
          | undefined;
        const email = profile?.email as string | undefined;
        await accountManager.addAccount(
          email,
          tokens.refresh,
          tokens.access,
          tokens.expires,
        );
      }

      return tokens?.type === "success" ? tokens : { type: "failed" as const };
    },
  });

  const buildAutoOAuthFlow = (
    pkce: { verifier: string },
    state: string,
    url: string,
    serverInfo: {
      waitForCode: (s: string) => Promise<{ code: string } | null>;
      close: () => void;
    },
  ) => ({
    url,
    method: "auto" as const,
    instructions: AUTH_LABELS.INSTRUCTIONS,
    callback: async () => {
      const result = await serverInfo.waitForCode(state);
      serverInfo.close();

      if (!result) {
        return { type: "failed" as const };
      }

      const tokens = await exchangeAuthorizationCode(
        result.code,
        pkce.verifier,
        REDIRECT_URI,
      );

      if (tokens?.type === "success") {
        const decoded = decodeJWT(tokens.access);
        const profile = decoded?.["https://api.openai.com/profile"] as
          | Record<string, unknown>
          | undefined;
        const email = profile?.email as string | undefined;
        await accountManager.addAccount(
          email,
          tokens.refresh,
          tokens.access,
          tokens.expires,
        );
      }

      return tokens?.type === "success" ? tokens : { type: "failed" as const };
    },
  });

  return {
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth: () => Promise<Auth>, provider: unknown) {
        const auth = await getAuth();

        if (auth.type !== "oauth") {
          return {};
        }

        if (accountManager.getAccountCount() === 0) {
          const decoded = decodeJWT(auth.access);
          const profile = decoded?.["https://api.openai.com/profile"] as
            | Record<string, unknown>
            | undefined;
          const email = profile?.email as string | undefined;
          await accountManager.addAccount(
            email,
            auth.refresh,
            auth.access,
            auth.expires,
          );
        }

        const providerConfig = provider as
          | { options?: Record<string, unknown>; models?: UserConfig["models"] }
          | undefined;
        const userConfig: UserConfig = {
          global: providerConfig?.options || {},
          models: providerConfig?.models || {},
        };

        const pluginConfig = loadPluginConfig();
        const codexMode = getCodexMode(pluginConfig);

        const executeRequest = async (
          account: ManagedAccount,
          input: Request | string | URL,
          init: RequestInit | undefined,
          retryCount = 0,
        ): Promise<Response> => {
          const isTokenValid = await accountManager.ensureValidToken(account);
          if (!isTokenValid) {
            const nextAccount = await accountManager.getNextAvailableAccount();
            if (nextAccount && nextAccount.index !== account.index) {
              await showAccountSwitchToast(account, nextAccount);
              return executeRequest(nextAccount, input, init, retryCount);
            }
            return new Response(
              JSON.stringify({ error: "All accounts failed token refresh" }),
              {
                status: HTTP_STATUS.UNAUTHORIZED,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          const originalUrl = extractRequestUrl(input);
          const url = rewriteUrlForCodex(originalUrl);

          const originalBody = init?.body
            ? JSON.parse(init.body as string)
            : {};
          const isStreaming = originalBody.stream === true;
          const model = originalBody.model;

          const transformation = await transformRequestForCodex(
            init,
            url,
            userConfig,
            codexMode,
          );
          const requestInit = transformation?.updatedInit ?? init;

          const accountId =
            account.accountId ||
            (() => {
              const decoded = decodeJWT(account.access || "");
              return decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
            })();

          if (!accountId) {
            logDebug(
              `[openai-multi-auth] No account ID for account ${account.index}`,
            );
            return new Response(
              JSON.stringify({ error: ERROR_MESSAGES.NO_ACCOUNT_ID }),
              {
                status: HTTP_STATUS.UNAUTHORIZED,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          const headers = createCodexHeaders(
            requestInit,
            accountId,
            account.access || "",
            {
              model: transformation?.body.model,
              promptCacheKey: (transformation?.body as any)?.prompt_cache_key,
            },
          );

          const response = await fetch(url, {
            ...requestInit,
            headers,
          });

          try {
            const headersObj: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              headersObj[key] = value;
            });
            await codexStatus.updateFromHeaders(account, headersObj);
          } catch (error) {
            if (debugMode) {
              console.log("[openai-multi-auth] codex-status update failed", error);
            }
          }

          logRequest(LOG_STAGES.RESPONSE, {
            status: response.status,
            ok: response.ok,
            statusText: response.statusText,
            accountIndex: account.index,
            accountEmail: account.email,
          });

          if (response.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
            const retryAfterHeader = response.headers.get("Retry-After");
            let retryAfterMs: number;

            if (retryAfterHeader) {
              retryAfterMs = parseInt(retryAfterHeader) * 1000;
            } else {
              try {
                const cloned = response.clone();
                const errorBody = (await cloned.json()) as any;
                const resetTime =
                  errorBody?.error?.details?.resets_at || errorBody?.resets_at;
                if (resetTime) {
                  retryAfterMs = new Date(resetTime).getTime() - Date.now();
                } else {
                  retryAfterMs = 60000;
                }
              } catch {
                retryAfterMs = 60000;
              }
            }

            accountManager.markRateLimited(account, retryAfterMs, model);
            await showRateLimitToast(account, retryAfterMs);

            if (debugMode) {
              const headersObj: Record<string, string> = {};
              response.headers.forEach((value, key) => {
                headersObj[key] = value;
              });
              try {
                const cloned = response.clone();
                const body = await cloned.json();
                console.log(
                  `[openai-multi-auth] Rate limit headers: ${JSON.stringify(headersObj)}, body: ${JSON.stringify(body)}, calculated: ${retryAfterMs}ms (${Math.ceil(Math.max(0, retryAfterMs) / 60000)}m)`,
                );
              } catch {}
            }

            if (retryCount < accountManager.getAccountCount() - 1) {
              const nextAccount =
                await accountManager.getNextAvailableAccount(model);
              if (nextAccount && nextAccount.index !== account.index) {
                await showAccountSwitchToast(account, nextAccount);
                return executeRequest(nextAccount, input, init, retryCount + 1);
              }
            }
          }

          if (response.status === HTTP_STATUS.UNAUTHORIZED && retryCount < 1) {
            accountManager.markRefreshFailed(account, "401 Unauthorized");
            const nextAccount =
              await accountManager.getNextAvailableAccount(model);
            if (nextAccount && nextAccount.index !== account.index) {
              await showAccountSwitchToast(account, nextAccount);
              return executeRequest(nextAccount, input, init, retryCount + 1);
            }
          }

          if (!response.ok) {
            return await handleErrorResponse(response);
          }

          return await handleSuccessResponse(response, isStreaming);
        };

        return {
          apiKey: DUMMY_API_KEY,
          baseURL: CODEX_BASE_URL,
          async fetch(
            input: Request | string | URL,
            init?: RequestInit,
          ): Promise<Response> {
            const model = extractModelFromBody(init?.body as string);
            const account = await accountManager.getNextAvailableAccount(model);

            if (!account) {
              return new Response(
                JSON.stringify({ error: "No available OpenAI accounts" }),
                {
                  status: 503,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }

            await showAccountToast(account, accountManager.getAccountCount());

            return executeRequest(account, input, init);
          },
        };
      },
      methods: [
        {
          label: AUTH_LABELS.OAUTH,
          type: "oauth" as const,
          authorize: async () => {
            const { pkce, state, url } = await createAuthorizationFlow();
            const serverInfo = await startLocalOAuthServer({ state });

            openBrowserUrl(url);

            if (!serverInfo.ready) {
              serverInfo.close();
              return buildManualOAuthFlow(pkce, url);
            }

            return buildAutoOAuthFlow(pkce, state, url, serverInfo);
          },
        },
        {
          label: "Add Another OpenAI Account",
          type: "oauth" as const,
          authorize: async () => {
            const { pkce, state, url } = await createAuthorizationFlow();
            const serverInfo = await startLocalOAuthServer({ state });

            openBrowserUrl(url);

            if (!serverInfo.ready) {
              serverInfo.close();
              return buildManualOAuthFlow(pkce, url);
            }

            return buildAutoOAuthFlow(pkce, state, url, serverInfo);
          },
        },
        {
          label: AUTH_LABELS.OAUTH_MANUAL,
          type: "oauth" as const,
          authorize: async () => {
            const { pkce, url } = await createAuthorizationFlow();
            return buildManualOAuthFlow(pkce, url);
          },
        },
        {
          label: AUTH_LABELS.API_KEY,
          type: "api" as const,
        },
      ],
    },
    config: async (cfg) => {
      cfg.command = cfg.command || {};
      cfg.command["codex-status"] = {
        template:
          "Run the codex-status tool and output the result EXACTLY as returned by the tool, without any additional text or commentary.",
        description: "List all configured OpenAI accounts and their current usage status.",
      };

      cfg.experimental = cfg.experimental || {};
      cfg.experimental.primary_tools = cfg.experimental.primary_tools || [];
      if (!cfg.experimental.primary_tools.includes("codex-status")) {
        cfg.experimental.primary_tools.push("codex-status");
      }
    },
    tool: {
      "codex-status": tool({
        description: "List all configured OpenAI accounts and their current usage status.",
        args: {},
        async execute() {
          const accounts = accountManager.getAllAccounts();
          if (accounts.length === 0) {
            return [
              "OpenAI Codex Status",
              "",
              "  Accounts: 0",
              "",
              "Add accounts:",
              "  opencode auth login",
            ].join("\n");
          }

          const now = Date.now();
          await Promise.all(
            accounts.map(async (acc) => {
              if (acc.access && acc.expires && acc.expires > now) {
                await codexStatus.fetchFromBackend(acc, acc.access);
              }
            }),
          );

          const active = accountManager.getActiveAccount();
          const activeIndex = active?.index ?? 0;
          const lines: string[] = ["OpenAI Codex Status", ""];

          for (const account of accounts) {
            const status = account.index === activeIndex ? "ACTIVE" : "READY";
            const email = account.email || `Account ${account.index + 1}`;
            const plan = account.planType || "Unknown";
            lines.push(`${account.index + 1}. ${status} ${email} [${plan}]`);
            const statusLines = await codexStatus.renderStatus(account);
            for (const line of statusLines) {
              lines.push(line);
            }
            lines.push("");
          }

          return lines.join("\n");
        },
      }),
    },
  };
};

export default OpenAIAuthPlugin;
