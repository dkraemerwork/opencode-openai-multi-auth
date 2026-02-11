import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import {
  createAuthorizationFlow,
  decodeJWT,
  extractAccountIdFromToken,
  exchangeAuthorizationCode,
  parseAuthorizationInput,
  REDIRECT_URI,
  validateAuthorizationState,
} from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import {
  AUTH_LABELS,
  CODEX_BASE_URL,
  DUMMY_API_KEY,
  ERROR_MESSAGES,
  LOG_STAGES,
  PROVIDER_ID,
  HTTP_STATUS,
  MODEL_FALLBACKS,
} from "./lib/constants.js";
import { logRequest, logDebug } from "./lib/logger.js";
import {
  createCodexHeaders,
  extractRequestUrl,
  handleErrorResponse,
  handleSuccessResponse,
  rewriteUrlForCodex,
  validateCodexBackendUrl,
} from "./lib/request/fetch-helpers.js";
import { AccountManager } from "./lib/accounts/index.js";
import type { ManagedAccount } from "./lib/accounts/index.js";
import { codexStatus } from "./lib/codex-status.js";
import { prefetchModels } from "./lib/models.js";
import { SessionBindingStore } from "./lib/session-bindings.js";

function extractModelFromBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    return parsed?.model;
  } catch {
    return undefined;
  }
}

function extractPromptCacheKeyFromBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.prompt_cache_key !== "string") {
      return undefined;
    }
    const key = parsed.prompt_cache_key.trim();
    return key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

let lastToastAccountIndex: number | null = null;
let lastToastTime = 0;
const TOAST_DEBOUNCE_MS = 5000;

/** Track which models we've already shown fallback notifications for */
const notifiedFallbacks = new Set<string>();

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
          message: `Switching ${fromLabel} -> ${toLabel}${toPlanLabel}`,
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

  const showModelRetryToast = async (
    model: string,
    failedAccount: ManagedAccount,
    nextAccount: ManagedAccount,
    triedCount: number,
    totalAccounts: number,
  ) => {
    if (quietMode) return;
    const failedLabel = failedAccount.email || `Account ${failedAccount.index + 1}`;
    const nextLabel = nextAccount.email || `Account ${nextAccount.index + 1}`;
    const nextPlan = nextAccount.planType ? ` [${nextAccount.planType}]` : "";
    try {
      await client.tui.showToast({
        body: {
          message: `${model} not on ${failedLabel}, trying ${nextLabel}${nextPlan} (${triedCount}/${totalAccounts})`,
          variant: "info",
        },
      });
    } catch {}
  };

  const showModelFallbackToast = async (
    originalModel: string,
    fallbackModel: string,
  ) => {
    if (quietMode) return;
    // Only show once per model to avoid spam
    const key = `${originalModel}->${fallbackModel}`;
    if (notifiedFallbacks.has(key)) return;
    notifiedFallbacks.add(key);
    try {
      await client.tui.showToast({
        body: {
          message: `${originalModel} not available yet. Using ${fallbackModel} instead.`,
          variant: "warning",
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

  const sessionBindingStore = new SessionBindingStore();
  sessionBindingStore.loadFromDisk();

  const findAccountByIndex = (index: number): ManagedAccount | null => {
    return accountManager.getAllAccounts().find((acc) => acc.index === index) || null;
  };

  const getSessionBoundAccount = async (
    sessionKey: string | undefined,
    model?: string,
  ): Promise<ManagedAccount | null> => {
    if (!sessionKey) {
      return accountManager.getNextAvailableAccount(model);
    }

    const boundIndex = sessionBindingStore.get(sessionKey);
    if (boundIndex !== undefined) {
      const bound = findAccountByIndex(boundIndex);
      if (bound) {
        return bound;
      }
      sessionBindingStore.delete(sessionKey);
    }

    const account = await accountManager.getNextAvailableAccountForNewSession(model);
    if (account) {
      sessionBindingStore.set(sessionKey, account.index);
    }
    return account;
  };

  const buildManualOAuthFlow = (
    pkce: { verifier: string },
    expectedState: string,
    url: string,
  ) => ({
    url,
    method: "code" as const,
    instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
    callback: async (input: string) => {
      const parsed = parseAuthorizationInput(input);
      if (!parsed.code || !validateAuthorizationState(parsed.state, expectedState)) {
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

        const executeRequest = async (
          account: ManagedAccount,
          input: Request | string | URL,
          init: RequestInit | undefined,
          retryCount = 0,
          triedAccountIndices: Set<number> = new Set(),
        ): Promise<Response> => {
          // Track this account as tried
          triedAccountIndices.add(account.index);
          const isTokenValid = await accountManager.ensureValidToken(account);
          if (!isTokenValid) {
            const nextAccount = await accountManager.getNextAvailableAccountExcluding(triedAccountIndices);
            if (nextAccount && nextAccount.index !== account.index) {
              await showAccountSwitchToast(account, nextAccount);
              return executeRequest(nextAccount, input, init, retryCount, triedAccountIndices);
            }
            return new Response(
              JSON.stringify({
                error:
                  "Token refresh failed for the current session account. Start a new session to switch accounts.",
              }),
              {
                status: HTTP_STATUS.UNAUTHORIZED,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          const originalUrl = extractRequestUrl(input);
          let url: string;
          try {
            url = validateCodexBackendUrl(rewriteUrlForCodex(originalUrl));
          } catch {
            return new Response(
              JSON.stringify({ error: ERROR_MESSAGES.INVALID_BACKEND_URL }),
              {
                status: HTTP_STATUS.BAD_REQUEST,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          let originalBody: Record<string, unknown> = {};
          if (typeof init?.body === "string") {
            try {
              originalBody = JSON.parse(init.body);
            } catch {
              originalBody = {};
            }
          }
          const isStreaming = originalBody.stream === true;
          const model =
            typeof originalBody.model === "string"
              ? originalBody.model
              : undefined;
          const promptCacheKey =
            typeof originalBody.prompt_cache_key === "string"
              ? originalBody.prompt_cache_key
              : undefined;

          const accountId =
            account.accountId || extractAccountIdFromToken(account.access || "");

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

          // Pre-fetch models to "register" client with backend
          // This may help unlock access to newer models like gpt-5.3-codex
          try {
            await prefetchModels(account.access || "", accountId);
          } catch {
            // Ignore errors - this is a best-effort optimization
          }

          const headers = createCodexHeaders(
            init,
            accountId,
            account.access || "",
            {
              model,
              promptCacheKey,
            },
          );

          const response = await fetch(url, {
            ...init,
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
                await accountManager.getNextAvailableAccountExcluding(triedAccountIndices, model);
              if (nextAccount && nextAccount.index !== account.index) {
                await showAccountSwitchToast(account, nextAccount);
                return executeRequest(nextAccount, input, init, retryCount + 1, triedAccountIndices);
              }
            }
          }

          if (response.status === HTTP_STATUS.UNAUTHORIZED) {
            accountManager.markRefreshFailed(account, "401 Unauthorized");
            const nextAccount =
              await accountManager.getNextAvailableAccountExcluding(triedAccountIndices, model);
            if (nextAccount && nextAccount.index !== account.index) {
              await showAccountSwitchToast(account, nextAccount);
              return executeRequest(nextAccount, input, init, retryCount + 1, triedAccountIndices);
            }
          }

          // Handle model not supported errors (400 Bad Request with specific message)
          if (response.status === 400) {
            try {
              const cloned = response.clone();
              const errorBody = await cloned.json() as { detail?: string; error?: { message?: string } };
              const detail = errorBody?.detail || errorBody?.error?.message || "";
              
              // Always log 400 errors to file for debugging
              const fs = await import("node:fs");
              const path = await import("node:path");
              const os = await import("node:os");
              const logDir = path.join(os.homedir(), ".opencode", "logs", "codex-plugin");
              fs.mkdirSync(logDir, { recursive: true });
              fs.writeFileSync(path.join(logDir, "last-400-error.json"), JSON.stringify({ 
                timestamp: new Date().toISOString(),
                model,
                status: response.status, 
                errorBody,
                detail,
                accountIndex: account.index,
                accountEmail: account.email,
                accountPlanType: account.planType,
                triedAccounts: Array.from(triedAccountIndices),
                totalAccounts: accountManager.getAccountCount(),
              }, null, 2));
              
              // Log the error for debugging
              if (debugMode) {
                console.log(`[openai-multi-auth] 400 error for model ${model} on account ${account.email || account.index} [${account.planType}]: ${JSON.stringify(errorBody)}`);
              }
              
              // Check if it's a "model not supported" error
              if (detail.includes("model is not supported") || detail.includes("not supported when using Codex")) {
                const requestedModel = typeof model === "string" ? model : "";
                if (!requestedModel) {
                  return await handleErrorResponse(response);
                }
                
                // STEP 1: Try other accounts first (they might be Plus/Pro/Team and support the model)
                const nextAccount = await accountManager.getNextAvailableAccountExcluding(triedAccountIndices, requestedModel);
                if (nextAccount) {
                  if (debugMode) {
                    console.log(`[openai-multi-auth] Model ${requestedModel} not supported on ${account.email || account.index} [${account.planType}], trying ${nextAccount.email || nextAccount.index} [${nextAccount.planType}]`);
                  }
                  await showModelRetryToast(
                    requestedModel,
                    account,
                    nextAccount,
                    triedAccountIndices.size,
                    accountManager.getAccountCount(),
                  );
                  return executeRequest(nextAccount, input, init, retryCount, triedAccountIndices);
                }
                
                // STEP 2: All accounts tried - fall back to older model
                const fallbackModel = MODEL_FALLBACKS[requestedModel];
                if (fallbackModel) {
                  if (debugMode) {
                    console.log(`[openai-multi-auth] All ${triedAccountIndices.size} accounts tried for ${requestedModel}, falling back to ${fallbackModel}`);
                  }
                  await showModelFallbackToast(requestedModel, fallbackModel);
                  
                  // Retry with fallback model using first available account (reset tried accounts for new model)
                  const modifiedBody = JSON.parse(init?.body as string || "{}");
                  modifiedBody.model = fallbackModel;
                  const modifiedInit = {
                    ...init,
                    body: JSON.stringify(modifiedBody),
                  };
                  
                  // Get first available account for the fallback model
                  const fallbackAccount = await accountManager.getNextAvailableAccount(fallbackModel);
                  if (fallbackAccount) {
                    // Reset tried accounts for the new model
                    return executeRequest(fallbackAccount, input, modifiedInit, 0, new Set());
                  }
                  // If no account available, use current account
                  return executeRequest(account, input, modifiedInit, retryCount + 1, new Set());
                }
              }
            } catch {
              // If parsing fails, continue with normal error handling
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
            const requestBody =
              typeof init?.body === "string" ? (init.body as string) : undefined;
            const model = extractModelFromBody(requestBody);
            const sessionKey = extractPromptCacheKeyFromBody(requestBody);
            const account = await getSessionBoundAccount(sessionKey, model);

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
              return buildManualOAuthFlow(pkce, state, url);
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
              return buildManualOAuthFlow(pkce, state, url);
            }

            return buildAutoOAuthFlow(pkce, state, url, serverInfo);
          },
        },
        {
          label: AUTH_LABELS.OAUTH_MANUAL,
          type: "oauth" as const,
          authorize: async () => {
            const { pkce, state, url } = await createAuthorizationFlow();
            return buildManualOAuthFlow(pkce, state, url);
          },
        },
        {
          label: AUTH_LABELS.API_KEY,
          type: "api" as const,
        },
      ],
    },
    "chat.headers": async (
      input: { model: { providerID: string }; sessionID: string },
      output: { headers: Record<string, string> },
    ) => {
      if (input.model.providerID !== PROVIDER_ID) return;
      output.headers = output.headers || {};
      output.headers.originator = "opencode";
      output.headers.session_id = input.sessionID;
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
