export class SessionContextStore {
  private readonly promptCacheKeys = new Map<string, string>();

  setPromptCacheKey(sessionId: string, promptCacheKey: string): void {
    const normalizedSessionId = sessionId.trim();
    const normalizedPromptCacheKey = promptCacheKey.trim();
    if (!normalizedSessionId || !normalizedPromptCacheKey) return;
    this.promptCacheKeys.set(normalizedSessionId, normalizedPromptCacheKey);
  }

  getPromptCacheKey(sessionId: string): string | undefined {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return undefined;
    return this.promptCacheKeys.get(normalizedSessionId);
  }
}
