import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function ensureSecureDir(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true, mode: DIR_MODE });
	}
	try {
		chmodSync(path, DIR_MODE);
	} catch {
		// Best effort; keep runtime resilient.
	}
}

export function ensureSecureFile(path: string): void {
	if (!existsSync(path)) return;
	try {
		chmodSync(path, FILE_MODE);
	} catch {
		// Best effort; keep runtime resilient.
	}
}

export function writeJsonSecure(path: string, data: unknown): void {
	const parent = dirname(path);
	ensureSecureDir(parent);

	const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: FILE_MODE });
	try {
		chmodSync(tempPath, FILE_MODE);
	} catch {
		// Best effort; keep runtime resilient.
	}
	renameSync(tempPath, path);
	ensureSecureFile(path);
}
