import { describe, expect, it } from "vitest";

import { createSearchWebTool } from "../src/tools/web/index.js";

function sseDelta(text: string): string {
  return `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: text })}\n\n`;
}

describe("search_web tool", () => {
  it("calls OpenAI Codex search with pi-squared auth and formats sources", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const responseJson = JSON.stringify({
      summary: "Pi-squared is a coding agent.",
      sources: [
        { title: "Source A", url: "https://example.com/a", snippet: "A relevant snippet." },
        { title: "Source B", url: "https://example.com/b", snippet: "Another snippet." },
      ],
    });
    const fetchMock: typeof fetch = async (url, init) => {
      request = { url: String(url), init: init ?? {} };
      return new Response(sseDelta(responseJson), { status: 200 });
    };

    const tool = createSearchWebTool({
      getAuth: async () => ({ accessToken: "access-token", accountId: "account-id" }),
      fetch: fetchMock,
      endpoint: "https://chatgpt.test/backend-api/codex/responses",
      model: "gpt-test",
      maxSources: 1,
      timeoutMs: 1_000,
    });

    const result = await tool.execute("call-1", { query: "what is pi-squared?", freshness: "live" });

    expect(tool.name).toBe("search_web");
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Pi-squared is a coding agent.\n\nSources:\n1. Source A\n   https://example.com/a\n   A relevant snippet.",
    });
    expect(result.details?.sourceCount).toBe(1);
    expect(request?.url).toBe("https://chatgpt.test/backend-api/codex/responses");
    expect(request?.init.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "ChatGPT-Account-ID": "account-id",
    });

    const body = JSON.parse(String(request?.init.body)) as {
      model: string;
      tools: { type: string }[];
      stream: boolean;
      store: boolean;
      instructions: string;
    };
    expect(body.model).toBe("gpt-test");
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.instructions).toContain("Limit sources to at most 1 items");
  });

  it("rejects empty queries", async () => {
    const tool = createSearchWebTool({
      getAuth: async () => ({ accessToken: "access-token", accountId: "account-id" }),
    });

    await expect(tool.execute("call-1", { query: "   " })).rejects.toThrow("non-empty query");
  });
});
