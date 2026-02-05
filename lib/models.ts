/**
 * Codex Models API
 * Fetches available models from the ChatGPT backend
 * This call may be necessary to "unlock" access to certain models like gpt-5.3-codex
 */

import { CODEX_BASE_URL, URL_PATHS, PLUGIN_VERSION, CODEX_ORIGINATOR } from "./constants.js";
import { release as osRelease } from "node:os";

/** Model info returned from the /models endpoint */
export interface ModelInfo {
	slug: string;
	display_name: string;
	description?: string;
	default_reasoning_level?: string;
	supported_reasoning_levels?: string[];
	visibility?: string;
	supported_in_api?: boolean;
}

/** Response from /models endpoint */
interface ModelsResponse {
	models: ModelInfo[];
}

/** Cache for available models per account */
const modelsCache = new Map<string, { models: ModelInfo[]; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generates User-Agent for models requests
 */
function getCodexUserAgent(): string {
	const platform = process.platform;
	const arch = process.arch;
	const osType = platform === "darwin" ? "Mac OS" : platform === "win32" ? "Windows" : "Linux";
	const osVersion = osRelease();
	return `${CODEX_ORIGINATOR}/${PLUGIN_VERSION} (${osType} ${osVersion}; ${arch}) opencode-plugin`;
}

/**
 * Fetch available models from the Codex backend
 * This call may help "register" the client and enable access to newer models
 *
 * @param accessToken - OAuth access token
 * @param accountId - ChatGPT account ID
 * @returns List of available models
 */
export async function fetchAvailableModels(
	accessToken: string,
	accountId: string,
): Promise<ModelInfo[]> {
	const cacheKey = accountId;
	const cached = modelsCache.get(cacheKey);

	// Return cached if still valid
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return cached.models;
	}

	const url = `${CODEX_BASE_URL}${URL_PATHS.CODEX_MODELS}?client_version=${PLUGIN_VERSION}`;

	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"chatgpt-account-id": accountId,
				"User-Agent": getCodexUserAgent(),
				originator: CODEX_ORIGINATOR,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			console.error(`[openai-codex-plugin] Failed to fetch models: ${response.status}`);
			return cached?.models || [];
		}

		const data = (await response.json()) as ModelsResponse;
		const models = data.models || [];

		// Cache the result
		modelsCache.set(cacheKey, { models, fetchedAt: Date.now() });

		return models;
	} catch (error) {
		console.error("[openai-codex-plugin] Error fetching models:", error);
		return cached?.models || [];
	}
}

/**
 * Check if a specific model is available for an account
 *
 * @param modelSlug - Model slug to check (e.g., "gpt-5.3-codex")
 * @param accessToken - OAuth access token
 * @param accountId - ChatGPT account ID
 * @returns True if model is available
 */
export async function isModelAvailable(
	modelSlug: string,
	accessToken: string,
	accountId: string,
): Promise<boolean> {
	const models = await fetchAvailableModels(accessToken, accountId);
	return models.some((m) => m.slug === modelSlug);
}

/**
 * Pre-fetch models to potentially "unlock" access to newer models
 * Call this before making requests to ensure the backend knows about our client
 *
 * @param accessToken - OAuth access token
 * @param accountId - ChatGPT account ID
 */
export async function prefetchModels(
	accessToken: string,
	accountId: string,
): Promise<void> {
	await fetchAvailableModels(accessToken, accountId);
}
