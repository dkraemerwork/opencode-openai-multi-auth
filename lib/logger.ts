import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PLUGIN_NAME } from "./constants.js";
import { ensureSecureDir, ensureSecureFile } from "./secure-file.js";

// Logging configuration
export const LOGGING_ENABLED = process.env.ENABLE_PLUGIN_REQUEST_LOGGING === "1";
export const DEBUG_ENABLED = process.env.DEBUG_CODEX_PLUGIN === "1" || LOGGING_ENABLED;
const LOG_DIR = join(homedir(), ".opencode", "logs", "codex-plugin");

// Log startup message about logging state
if (LOGGING_ENABLED) {
	console.log(`[${PLUGIN_NAME}] Request logging ENABLED - logs will be saved to:`, LOG_DIR);
}
if (DEBUG_ENABLED && !LOGGING_ENABLED) {
	console.log(`[${PLUGIN_NAME}] Debug logging ENABLED`);
}

let requestCounter = 0;

const REDACTED = "[REDACTED]";
const OMITTED = "[OMITTED]";
const SENSITIVE_KEY_PATTERN =
	/(authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|cookie|chatgpt-account-id|account_id)/i;
const OMITTED_CONTENT_KEYS = /^(body|fullContent)$/i;

export function sanitizeLogData(input: unknown): unknown {
	if (Array.isArray(input)) {
		return input.map((item) => sanitizeLogData(item));
	}

	if (input && typeof input === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
			if (OMITTED_CONTENT_KEYS.test(key)) {
				result[key] = OMITTED;
				continue;
			}
			if (SENSITIVE_KEY_PATTERN.test(key)) {
				result[key] = REDACTED;
				continue;
			}
			result[key] = sanitizeLogData(value);
		}
		return result;
	}

	return input;
}

/**
 * Log request data to file (only when LOGGING_ENABLED is true)
 * @param stage - The stage of the request (e.g., "before-transform", "after-transform")
 * @param data - The data to log
 */
export function logRequest(stage: string, data: Record<string, unknown>): void {
	// Only log if explicitly enabled via environment variable
	if (!LOGGING_ENABLED) return;

	ensureSecureDir(LOG_DIR);

	const timestamp = new Date().toISOString();
	const requestId = ++requestCounter;
	const filename = join(LOG_DIR, `request-${requestId}-${stage}.json`);

	try {
		const safeData = sanitizeLogData(data) as Record<string, unknown>;
		writeFileSync(
			filename,
			JSON.stringify(
				{
					timestamp,
					requestId,
					stage,
					...safeData,
				},
				null,
				2,
			),
			{ encoding: "utf8", mode: 0o600 },
		);
		ensureSecureFile(filename);
		console.log(`[${PLUGIN_NAME}] Logged ${stage} to ${filename}`);
	} catch (e) {
		const error = e as Error;
		console.error(`[${PLUGIN_NAME}] Failed to write log:`, error.message);
	}
}

/**
 * Log debug information (only when DEBUG_ENABLED is true)
 * @param message - Debug message
 * @param data - Optional data to log
 */
export function logDebug(message: string, data?: unknown): void {
	if (!DEBUG_ENABLED) return;

	if (data !== undefined) {
		console.log(`[${PLUGIN_NAME}] ${message}`, data);
	} else {
		console.log(`[${PLUGIN_NAME}] ${message}`);
	}
}

/**
 * Log warning (always enabled for important issues)
 * @param message - Warning message
 * @param data - Optional data to log
 */
export function logWarn(message: string, data?: unknown): void {
	if (!DEBUG_ENABLED && !LOGGING_ENABLED) return;
	if (data !== undefined) {
		console.warn(`[${PLUGIN_NAME}] ${message}`, data);
	} else {
		console.warn(`[${PLUGIN_NAME}] ${message}`);
	}
}
