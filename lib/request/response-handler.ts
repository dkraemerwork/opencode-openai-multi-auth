import { logRequest, LOGGING_ENABLED } from "../logger.js";
import type { SSEEventData } from "../types.js";

/**
 * Parse SSE stream to extract final response
 * @param sseText - Complete SSE stream text
 * @returns Final response object or null if not found
 */
function parseSseStream(sseText: string): unknown | null {
	const parsePayload = (payload: string): unknown | null => {
		if (!payload || payload === '[DONE]') return null;
		try {
			const data = JSON.parse(payload) as SSEEventData;
			if (data.type === 'response.done' || data.type === 'response.completed') {
				return data.response;
			}
		} catch {
			return null;
		}
		return null;
	};

	const events = sseText.replace(/\r\n/g, '\n').split('\n\n');

	for (const eventBlock of events) {
		const dataLines: string[] = [];

		for (const line of eventBlock.split('\n')) {
			if (!line.startsWith('data:')) continue;
			const payload = line.slice(5);
			dataLines.push(payload.startsWith(' ') ? payload.slice(1) : payload);
		}

		if (dataLines.length === 0) continue;

		const payload = dataLines.join('\n').trim();
		const parsed = parsePayload(payload);
		if (parsed) return parsed;
	}

	// Some providers emit one JSON payload per data line without SSE blank-line delimiters.
	for (const line of sseText.replace(/\r\n/g, '\n').split('\n')) {
		if (!line.startsWith('data:')) continue;
		const payload = line.slice(5).trimStart();
		const parsed = parsePayload(payload);
		if (parsed) return parsed;
	}

	return null;
}

/**
 * Convert SSE stream response to JSON for generateText()
 * @param response - Fetch response with SSE stream
 * @param headers - Response headers
 * @returns Response with JSON body
 */
export async function convertSseToJson(response: Response, headers: Headers): Promise<Response> {
	if (!response.body) {
		throw new Error('[openai-codex-plugin] Response has no body');
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let fullText = '';

	try {
		// Consume the entire stream
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			fullText += decoder.decode(value, { stream: true });
		}

		// Flush any buffered UTF-8 code units at stream end.
		fullText += decoder.decode();

		if (LOGGING_ENABLED) {
			logRequest("stream-full", { fullContent: fullText });
		}

		// Parse SSE events to extract the final response
		const finalResponse = parseSseStream(fullText);

		if (!finalResponse) {
			console.error('[openai-codex-plugin] Could not find final response in SSE stream');
			logRequest("stream-error", { error: "No response.done event found" });

			// Return original stream if we can't parse
			return new Response(fullText, {
				status: response.status,
				statusText: response.statusText,
				headers: headers,
			});
		}

		// Return as plain JSON (not SSE)
		const jsonHeaders = new Headers(headers);
		jsonHeaders.set('content-type', 'application/json; charset=utf-8');

		return new Response(JSON.stringify(finalResponse), {
			status: response.status,
			statusText: response.statusText,
			headers: jsonHeaders,
		});

	} catch (error) {
		console.error('[openai-codex-plugin] Error converting stream:', error);
		logRequest("stream-error", { error: String(error) });
		throw error;
	}
}

/**
 * Ensure response has content-type header
 * @param headers - Response headers
 * @returns Headers with content-type set
 */
export function ensureContentType(headers: Headers): Headers {
	const responseHeaders = new Headers(headers);

	if (!responseHeaders.has('content-type')) {
		responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
	}

	return responseHeaders;
}
