import type { AntigravityAccount } from "antigravity-proxy/src/auth/types.js";
import type { LanguageModelV3StreamPart, ProviderV3 } from "@ai-sdk/provider";
import { ReadableStream } from "node:stream/web";

export function createAntigravityProxyProvider({
  account,
}: {
  account: AntigravityAccount;
}): ProviderV3 {
  console.log(
    `Creating provider with account: ${JSON.stringify(account, null, 2)}`,
  );
  return {
    specificationVersion: "v3",
    languageModel(modelId) {
      return {
        specificationVersion: "v3",
        provider: "antigravity-proxy",
        modelId,
        supportedUrls: {},
        async doGenerate() {
          throw new Error("Sorry, only streaming is supported for now");
        },
        async doStream(options) {
          console.log(
            `Calling model ${modelId} with options: ${JSON.stringify(options, null, 2)}`,
          );
          const stream = new ReadableStream<LanguageModelV3StreamPart>({
            async start(controller) {
              controller.enqueue({
                type: "stream-start",
                warnings: [],
              });
              await new Promise((resolve) => setTimeout(resolve, 1000));
              controller.enqueue({
                type: "finish",
                finishReason: {
                  unified: "stop",
                  raw: undefined,
                },
                usage: {
                  inputTokens: {
                    cacheRead: undefined,
                    cacheWrite: undefined,
                    noCache: undefined,
                    total: undefined,
                  },
                  outputTokens: {
                    text: undefined,
                    reasoning: undefined,
                    total: undefined,
                  },
                  raw: undefined,
                },
              });
              controller.close();
            },
          });
          return {
            stream,
          };
        },
      };
    },
    embeddingModel() {
      throw new Error("Sorry, only language models are supported for now");
    },
    imageModel() {
      throw new Error("Sorry, only language models are supported for now");
    },
    rerankingModel() {
      throw new Error("Sorry, only language models are supported for now");
    },
  };
}
