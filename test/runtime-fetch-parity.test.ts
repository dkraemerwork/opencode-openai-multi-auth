import { describe, it, expect, vi, beforeEach } from 'vitest';

const transformRequestForCodexMock = vi.fn();
const sessionBindings = new Map<string, number>();
const accounts = [
	{
		index: 0,
		email: 'alpha@example.com',
		access: 'access-token-a',
		expires: Date.now() + 60_000,
		accountId: 'acct_alpha',
	},
	{
		index: 1,
		email: 'beta@example.com',
		access: 'access-token-b',
		expires: Date.now() + 60_000,
		accountId: 'acct_beta',
	},
];

vi.mock('@opencode-ai/plugin', () => ({
	tool: Object.assign((definition: unknown) => definition, {
		schema: {
			string: () => ({
				describe: () => ({ type: 'string' }),
			}),
		},
	}),
}));

vi.mock('../lib/request/fetch-helpers.js', async () => {
	const actual = await vi.importActual<typeof import('../lib/request/fetch-helpers.js')>(
		'../lib/request/fetch-helpers.js',
	);
	return {
		...actual,
		transformRequestForCodex: transformRequestForCodexMock,
	};
});

vi.mock('../lib/accounts/index.js', () => {
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

vi.mock('../lib/session-bindings.js', () => {
	class SessionContextStore {
		private readonly promptCacheKeys = new Map<string, string>();

		getPromptCacheKey(sessionId: string) {
			return this.promptCacheKeys.get(sessionId);
		}

		setPromptCacheKey(sessionId: string, promptCacheKey: string) {
			this.promptCacheKeys.set(sessionId, promptCacheKey);
		}
	}

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

	return { SessionBindingStore, SessionContextStore };
});

function requireAuthLoader(plugin: { auth?: { loader?: unknown } }) {
	if (typeof plugin.auth?.loader !== 'function') {
		throw new Error('Expected plugin auth loader to be available');
	}

	return plugin.auth.loader as (
		getAuth: () => Promise<unknown>,
		provider: unknown,
	) => Promise<{ fetch: (input: string, init: RequestInit) => Promise<Response> }>;
}

describe('Runtime fetch parity', () => {
	beforeEach(() => {
		transformRequestForCodexMock.mockReset();
		sessionBindings.clear();
		(globalThis as any).fetch = vi.fn(async () => {
			return new Response('data: {"type":"response.done"}\n\n', {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			});
		});
	});

	it('does not call transformRequestForCodex in runtime fetch path', async () => {
		const { OpenAIAuthPlugin } = await import('../index.js');

		const plugin = await OpenAIAuthPlugin({
			client: {
				auth: { set: vi.fn() },
				tui: { showToast: vi.fn() },
			},
		} as any);

		const loader = await requireAuthLoader(plugin)(
			async () => ({
				type: 'oauth',
				access: 'access-token',
				refresh: 'refresh-token',
				expires: Date.now() + 60_000,
			}) as any,
			{} as any,
		);

		await loader.fetch('https://chatgpt.com/backend-api/responses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				prompt_cache_key: 'ses_test_key',
				input: [{ type: 'message', role: 'user', content: 'hello' }],
			}),
		});

		expect(transformRequestForCodexMock).not.toHaveBeenCalled();
		expect((globalThis as any).fetch).toHaveBeenCalled();
	});

	it('inherits the parent session account binding for a new subagent session', async () => {
		const { OpenAIAuthPlugin } = await import('../index.js');

		const plugin = await OpenAIAuthPlugin({
			client: {
				auth: { set: vi.fn() },
				tui: { showToast: vi.fn() },
				session: {
					get: vi.fn(async ({ path }: { path: { id: string } }) => {
						if (path.id === 'child-session') {
							return { data: { id: 'child-session', parentID: 'parent-session' } };
						}
						if (path.id === 'parent-session') {
							return { data: { id: 'parent-session' } };
						}
						return { data: { id: path.id } };
					}),
				},
			},
		} as any);

		const loader = await requireAuthLoader(plugin)(
			async () => ({
				type: 'oauth',
				access: 'access-token',
				refresh: 'refresh-token',
				expires: Date.now() + 60_000,
			}) as any,
			{} as any,
		);

		await loader.fetch('https://chatgpt.com/backend-api/responses', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				session_id: 'parent-session',
			},
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				prompt_cache_key: 'ses_parent_key',
				input: [{ type: 'message', role: 'user', content: 'parent' }],
			}),
		});

		sessionBindings.set('ses_parent_key', 1);

		await loader.fetch('https://chatgpt.com/backend-api/responses', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				session_id: 'child-session',
			},
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				prompt_cache_key: 'ses_child_key',
				input: [{ type: 'message', role: 'user', content: 'child' }],
			}),
		});

		expect(sessionBindings.get('ses_child_key')).toBe(1);
		const lastCall = (globalThis as any).fetch.mock.calls.at(-1);
		const headers = new Headers(lastCall[1].headers);
		expect(headers.get('chatgpt-account-id')).toBe('acct_beta');
	});
});
