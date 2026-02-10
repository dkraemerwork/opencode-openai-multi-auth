import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionBindingStore } from "../lib/session-bindings.js";

describe("SessionBindingStore", () => {
	const tempRoots: string[] = [];

	afterEach(() => {
		for (const root of tempRoots.splice(0, tempRoots.length)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createStore(): { root: string; filePath: string; store: SessionBindingStore } {
		const root = mkdtempSync(join(tmpdir(), "opencode-session-bindings-"));
		tempRoots.push(root);
		const filePath = join(root, "session-bindings.json");
		const store = new SessionBindingStore(filePath);
		return { root, filePath, store };
	}

	it("loads empty state when file does not exist", () => {
		const { store } = createStore();
		store.loadFromDisk();
		expect(store.get("ses_missing")).toBeUndefined();
	});

	it("persists bindings across store instances", () => {
		const { filePath, store } = createStore();
		store.loadFromDisk();
		store.set("ses_abc", 1);

		const nextStore = new SessionBindingStore(filePath);
		nextStore.loadFromDisk();
		expect(nextStore.get("ses_abc")).toBe(1);
	});

	it("persists deletes across store instances", () => {
		const { filePath, store } = createStore();
		store.loadFromDisk();
		store.set("ses_abc", 2);
		store.delete("ses_abc");

		const nextStore = new SessionBindingStore(filePath);
		nextStore.loadFromDisk();
		expect(nextStore.get("ses_abc")).toBeUndefined();
	});

	it("ignores malformed persistence files", () => {
		const { filePath, store } = createStore();
		writeFileSync(filePath, "not-json", "utf8");
		expect(() => store.loadFromDisk()).not.toThrow();
		expect(store.get("ses_abc")).toBeUndefined();
	});
});
