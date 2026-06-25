import { describe, it, expect } from "vitest";
import { createAntigravityProxyProvider, promptToOpenAIMessages } from "./provider.js";
import { transformToGoogleBody } from "antigravity-proxy/src/utils/transform.js";
import { ModelMessage, streamText } from "ai";

describe("provider", () => {
  it("safely creates the provider", async () => {
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
  });

  it("converts basic text tool result for gemini 3", async () => {
    const googleBody = transformToGoogleBody({
      model: "gemini-3-flash",
      messages: [
        {
          role: "tool",
          tool_call_id: "123",
          name: "test",
          content: "test"
        }
      ]
    }, "test", false, "us-central1");
    expect(googleBody.request.contents[0].parts[0].functionResponse.response.result).toBe("test");
  });

  it("passes multimodal content tool results through to openai messages", () => {
    const messages = promptToOpenAIMessages(
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "screenshot",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "Captured screen" },
                  {
                    type: "image-data",
                    mediaType: "image/png",
                    data: "abc123",
                  },
                ],
              },
            },
          ],
        },
      ],
      [],
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      name: "screenshot",
      content: [
        { type: "text", text: "Captured screen" },
        { type: "image-data", mediaType: "image/png", data: "abc123" },
      ],
    });
  });

  it("converts multimodal content tool results for gemini 3", async () => {
    const googleBody = await transform("gemini-3-flash", [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "screenshot",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Captured screen" },
                {
                  type: "image-data",
                  mediaType: "image/png",
                  data: "abc123",
                },
              ],
            },
          },
        ],
      },
    ]);

    const funcResp = googleBody.request.contents[0].parts[0].functionResponse;
    expect(funcResp.id).toBe("call_1");
    expect(funcResp.response.content).toBe("Captured screen");
    expect(funcResp.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "abc123" } },
    ]);
  });

  it("converts multimodal content tool results for legacy models", async () => {
    const googleBody = await transform("gemini-2.0-flash", [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "screenshot",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Captured screen" },
                {
                  type: "image-data",
                  mediaType: "image/png",
                  data: "abc123",
                },
              ],
            },
          },
        ],
      },
    ]);

    const parts = googleBody.request.contents[0].parts;
    expect(parts[0].functionResponse.response.content).toBe("Captured screen");
    expect(parts[1].inlineData).toEqual({
      mimeType: "image/png",
      data: "abc123",
    });
    expect(parts[2].text).toBe(
      "Tool executed successfully and returned this image as a response",
    );
  });
});

export async function transform(model: string, messages: ModelMessage[]) {
  const stream = streamText({
    model: createAntigravityProxyProvider({account: {email: "", refreshToken: "", lastUsed: 0, healthScore: 0, tokenUsage: 0}, test: true}).languageModel(model),
    messages,
  });
  for await (const chunk of stream.fullStream) {
    if (chunk.type === "text-delta") {
      return JSON.parse(chunk.text);
    }
  }
  throw new Error("No response from test stream");
}