import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface PersistedSessionBindings {
	version: 1;
	bindings: Record<string, number>;
}

export const DEFAULT_SESSION_BINDINGS_FILE = join(
	homedir(),
	".config",
	"opencode",
	"openai-multi-auth-session-bindings.json",
);

export class SessionBindingStore {
	private readonly bindings = new Map<string, number>();

	constructor(private readonly filePath = DEFAULT_SESSION_BINDINGS_FILE) {}

	loadFromDisk(): void {
		if (!existsSync(this.filePath)) return;

		try {
			const raw = readFileSync(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<PersistedSessionBindings>;
			const loaded = parsed?.bindings;
			if (!loaded || typeof loaded !== "object") return;

			for (const [sessionKey, accountIndex] of Object.entries(loaded)) {
				if (!sessionKey) continue;
				if (!Number.isInteger(accountIndex) || accountIndex < 0) continue;
				this.bindings.set(sessionKey, accountIndex);
			}
		} catch {
			// Ignore malformed files; plugin continues with in-memory map.
		}
	}

	get(sessionKey: string): number | undefined {
		return this.bindings.get(sessionKey);
	}

	set(sessionKey: string, accountIndex: number): void {
		this.bindings.set(sessionKey, accountIndex);
		this.saveToDisk();
	}

	delete(sessionKey: string): void {
		if (!this.bindings.delete(sessionKey)) return;
		this.saveToDisk();
	}

	private saveToDisk(): void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			const payload: PersistedSessionBindings = {
				version: 1,
				bindings: Object.fromEntries(this.bindings.entries()),
			};
			writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf8");
		} catch {
			// Persistence failure should not break request handling.
		}
	}
}
