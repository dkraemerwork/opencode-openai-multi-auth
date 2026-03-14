import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
	accounts: [
		{
			index: 0,
			email: 'test-1@example.com',
			access: 'access-token-1',
			expires: Date.now() + 60_000,
			accountId: 'acct_1',
		},
	],
	activeIndex: 0,
	limitedByModel: new Map<string, Set<number>>(),
	sessionBindings: new Map<string, number>(),
}));

function createMockAccount(index: number) {
	return {
		index,
		email: `test-${index + 1}@example.com`,
		access: `access-token-${index + 1}`,
		expires: Date.now() + 60_000,
		accountId: `acct_${index + 1}`,
	};
}

function getLimitedSet(model?: string) {
	const key = model || '__global__';
	const existing = mockState.limitedByModel.get(key);
	if (existing) return existing;

	const created = new Set<number>();
	mockState.limitedByModel.set(key, created);
	return created;
}

function getNextAvailableAccount(model?: string, exclude: Set<number> = new Set()) {
	const limited = getLimitedSet(model);
	const account = mockState.accounts.find(
		(candidate) => !exclude.has(candidate.index) && !limited.has(candidate.index),
	);
	if (!account) return null;

	mockState.activeIndex = account.index;
	return account;
}

vi.mock('@opencode-ai/plugin', () => ({
	tool: (definition: unknown) => definition,
}));

vi.mock('../lib/accounts/index.js', () => {
	class AccountManager {
		async loadFromDisk() {}
		async importFromOpenCodeAuth() {}
		getAllAccounts() {
			return mockState.accounts;
		}
		getAccountCount() {
			return mockState.accounts.length;
		}
		getActiveAccount() {
			return mockState.accounts[mockState.activeIndex] || null;
		}
		async getNextAvailableAccount(model?: string) {
			return getNextAvailableAccount(model);
		}
		async getNextAvailableAccountForNewSession(model?: string) {
			return getNextAvailableAccount(model);
		}
		async getNextAvailableAccountExcluding(
			excludeIndices: Set<number>,
			model?: string,
		) {
			return getNextAvailableAccount(model, excludeIndices);
		}
		isAccountAvailableForModel(account: { index: number }, model?: string) {
			return !getLimitedSet(model).has(account.index);
		}
		async ensureValidToken() {
			return true;
		}
		markRateLimited(account: { index: number }, _retryAfterMs: number, model?: string) {
			getLimitedSet(model).add(account.index);
		}
		markRefreshFailed() {}
		async addAccount() {}
	}

	return { AccountManager };
});

vi.mock('../lib/session-bindings.js', () => {
	class SessionBindingStore {
		loadFromDisk() {}
		get(key: string) {
			return mockState.sessionBindings.get(key);
		}
		set(key: string, value: number) {
			mockState.sessionBindings.set(key, value);
		}
		delete(key: string) {
			mockState.sessionBindings.delete(key);
		}
	}

	return { SessionBindingStore };
});

describe('Session failover binding', () => {
	beforeEach(() => {
		vi.resetModules();
		mockState.accounts = [createMockAccount(0), createMockAccount(1)];
		mockState.activeIndex = 0;
		mockState.limitedByModel.clear();
		mockState.sessionBindings.clear();
	});

	it('rebinds later prompts to the failover account after a 429', async () => {
		const authHeaders: string[] = [];
		let requestCount = 0;
		(globalThis as any).fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/models')) {
				return new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}

			const headers = new Headers(init?.headers as HeadersInit | undefined);
			authHeaders.push(headers.get('authorization') || '');
			requestCount++;

			if (requestCount === 1) {
				return new Response(
					JSON.stringify({
						resets_at: new Date(Date.now() + 60_000).toISOString(),
					}),
					{
						status: 429,
						headers: { 'content-type': 'application/json' },
					},
				);
			}

			return new Response('data: {"type":"response.done"}\n\n', {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			});
		});

		const { OpenAIAuthPlugin } = await import('../index.js');
		const plugin = await OpenAIAuthPlugin({
			client: {
				auth: { set: vi.fn() },
				tui: { showToast: vi.fn() },
			},
		} as any);

		const loader = await plugin.auth.loader(
			async () => ({
				type: 'oauth',
				access: 'access-token-1',
				refresh: 'refresh-token',
				expires: Date.now() + 60_000,
			}) as any,
			{} as any,
		);

		const request = {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.2-codex',
				prompt_cache_key: 'ses_test_key',
				input: [{ type: 'message', role: 'user', content: 'hello' }],
			}),
		};

		await loader.fetch('https://chatgpt.com/backend-api/responses', request);

		expect(authHeaders).toEqual(['Bearer access-token-1', 'Bearer access-token-2']);
		expect(mockState.sessionBindings.get('ses_test_key')).toBe(1);

		const secondPromptAuthHeaders: string[] = [];
		(globalThis as any).fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/models')) {
				return new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}

			const headers = new Headers(init?.headers as HeadersInit | undefined);
			secondPromptAuthHeaders.push(headers.get('authorization') || '');
			return new Response('data: {"type":"response.done"}\n\n', {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			});
		});

		await loader.fetch('https://chatgpt.com/backend-api/responses', request);

		expect(secondPromptAuthHeaders).toEqual(['Bearer access-token-2']);
	});
});
