import { describe, it, expect } from "vitest";
import { createAntigravityProxyProvider } from "./provider.js";
import { streamText, type TextStreamPart, type ToolSet } from "ai";

describe("provider", () => {
  it("should support streaming a language model", async () => {
    const provider = createAntigravityProxyProvider({
      account: {
        email: "",
        refreshToken: "",
        lastUsed: 0,
        healthScore: 0,
        tokenUsage: 0,
      },
    });
    expect(provider).toBeDefined();

    const tools: ToolSet = {};

    const stream = streamText({
      model: provider.languageModel("gemini-3.1-flash-lite"),
      messages: [{ role: "user", content: "Hello" }],
      tools,
    });
    expect(stream).toBeDefined();

    const chunks: TextStreamPart<typeof tools>[] = [];
    for await (const chunk of stream.fullStream) {
      console.log(chunk);
      chunks.push(chunk);
    }
    expect(chunks.find((c) => c.type === "start-step")).toBeDefined();
  });
});
