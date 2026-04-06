import { describe, expect, it } from "vitest";
import { SessionContextStore } from "../lib/session-context.js";

describe("SessionContextStore", () => {
  it("stores and returns prompt cache keys by session id", () => {
    const store = new SessionContextStore();
    store.setPromptCacheKey("session-1", "ses_prompt_1");

    expect(store.getPromptCacheKey("session-1")).toBe("ses_prompt_1");
  });

  it("ignores blank values", () => {
    const store = new SessionContextStore();
    store.setPromptCacheKey("", "ses_prompt_1");
    store.setPromptCacheKey("session-1", "");

    expect(store.getPromptCacheKey("session-1")).toBeUndefined();
  });
});
