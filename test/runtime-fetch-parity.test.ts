import { describe, it, expect, vi, beforeEach } from 'vitest';

const transformRequestForCodexMock = vi.fn();

vi.mock('@opencode-ai/plugin', () => ({
	tool: (definition: unknown) => definition,
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
		private account = {
			index: 0,
			email: 'test@example.com',
			access: 'access-token',
			expires: Date.now() + 60_000,
			accountId: 'acct_123',
		};

		async loadFromDisk() {}
		async importFromOpenCodeAuth() {}
		getAllAccounts() {
			return [this.account];
		}
		getAccountCount() {
			return 1;
		}
		getActiveAccount() {
			return this.account;
		}
		async getNextAvailableAccount() {
			return this.account;
		}
		async getNextAvailableAccountForNewSession() {
			return this.account;
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
	class SessionBindingStore {
		private map = new Map<string, number>();
		loadFromDisk() {}
		get(key: string) {
			return this.map.get(key);
		}
		set(key: string, value: number) {
			this.map.set(key, value);
		}
		delete(key: string) {
			this.map.delete(key);
		}
	}

	return { SessionBindingStore };
});

describe('Runtime fetch parity', () => {
	beforeEach(() => {
		transformRequestForCodexMock.mockReset();
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

		const loader = await plugin.auth.loader(
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
});
