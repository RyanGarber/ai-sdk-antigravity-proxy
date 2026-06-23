import type {
  AntigravityAccount,
  DeviceFingerprint,
} from "antigravity-proxy/src/auth/types.js";
import { refreshAccessToken } from "antigravity-proxy/src/auth/oauth.js";
import { getProjectId } from "antigravity-proxy/src/auth/oauth.js";
import {
  transformToGoogleBody,
  transformGoogleEventToOpenAI,
} from "antigravity-proxy/src/utils/transform.js";
import {
  getImpersonationHeaders,
  generateFingerprint,
} from "antigravity-proxy/src/utils/headers.js";
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3FunctionTool,
  ProviderV3,
} from "@ai-sdk/provider";

export type { AntigravityAccount };

// ---------------------------------------------------------------------------
// In-memory token cache — keyed by refresh token, entirely stateless
// The cache lives at module scope so it persists across calls within a session
// while never touching any filesystem or external storage.
// ---------------------------------------------------------------------------

interface CachedToken {
  accessToken: string;
  projectId: string;
  fingerprint: DeviceFingerprint;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

const TOKEN_EXPIRY_BUFFER_MS = 60_000;

async function getValidToken(
  account: AntigravityAccount,
): Promise<CachedToken> {
  const cached = tokenCache.get(account.refreshToken);
  if (cached && Date.now() < cached.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    return cached;
  }

  const tokenRes = await refreshAccessToken(account.refreshToken);
  const accessToken = tokenRes.access_token;
  const expiresAt = Date.now() + tokenRes.expires_in * 1_000;

  // Re-use projectId from account if available, otherwise discover it
  const projectId =
    account.projectId ?? cached?.projectId ?? (await getProjectId(accessToken));

  // Re-use fingerprint from account if available so headers stay stable
  const fingerprint: DeviceFingerprint =
    account.fingerprint ??
    cached?.fingerprint ??
    generateFingerprint(account.email);

  const entry: CachedToken = { accessToken, projectId, fingerprint, expiresAt };
  tokenCache.set(account.refreshToken, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Prompt conversion: AI SDK v3 → OpenAI chat messages
// ---------------------------------------------------------------------------

function promptToOpenAIMessages(
  prompt: LanguageModelV3CallOptions["prompt"],
): unknown[] {
  const messages: unknown[] = [];

  for (const msg of prompt as LanguageModelV3Message[]) {
    if (msg.role === "system") {
      messages.push({ role: "system", content: msg.content });
      continue;
    }

    if (msg.role === "user") {
      const parts = msg.content;
      const textParts = parts.filter((p) => p.type === "text");
      const fileParts = parts.filter((p) => p.type === "file");

      if (fileParts.length > 0) {
        const contentArray: unknown[] = [];
        for (const p of parts) {
          if (p.type === "text") {
            contentArray.push({ type: "text", text: p.text });
          } else if (p.type === "file" && p.mediaType.startsWith("image/")) {
            const data =
              p.data instanceof Uint8Array
                ? `data:${p.mediaType};base64,${uint8ToBase64(p.data)}`
                : String(p.data);
            contentArray.push({ type: "image_url", image_url: { url: data } });
          }
        }
        messages.push({ role: "user", content: contentArray });
      } else {
        const text = textParts
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("");
        messages.push({ role: "user", content: text });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const textContent = msg.content
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("");

      const toolCallParts = msg.content.filter((p) => p.type === "tool-call");
      const toolCalls =
        toolCallParts.length > 0
          ? toolCallParts
              .map((p) => {
                if (p.type !== "tool-call") return undefined;
                return {
                  id: p.toolCallId,
                  type: "function",
                  function: {
                    name: p.toolName,
                    arguments:
                      typeof p.input === "string"
                        ? p.input
                        : JSON.stringify(p.input),
                  },
                };
              })
              .filter(Boolean)
          : undefined;

      messages.push({
        role: "assistant",
        content: textContent || null,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (msg.role === "tool") {
      for (const result of msg.content) {
        if (result.type !== "tool-result") continue;
        const out = result.output;
        const outputValue =
          out.type === "text"
            ? out.value
            : out.type === "json"
              ? JSON.stringify(out.value)
              : "";
        messages.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          name: result.toolName,
          content: outputValue,
        });
      }
      continue;
    }
  }

  return messages;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Response stream: Google SSE → AI SDK v3 stream parts
// ---------------------------------------------------------------------------

function createAISDKStream(
  googleBody: ReadableStream<Uint8Array>,
  modelId: string,
  requestId: string,
): ReadableStream<LanguageModelV3StreamPart> {
  const decoder = new TextDecoder();
  let buffer = "";
  let hasPriorToolCalls = false;

  // Track open text/reasoning/tool blocks by id so we can open and close them
  let activeTextId: string | null = null;
  let activeReasoningId: string | null = null;
  // tool call id → whether start was emitted
  const activeToolIds = new Map<string, boolean>();

  return new ReadableStream<LanguageModelV3StreamPart>({
    async start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });

      const reader = googleBody.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") continue;

            let googleEvent: unknown;
            try {
              googleEvent = JSON.parse(dataStr);
            } catch {
              continue;
            }

            const chunk = transformGoogleEventToOpenAI(
              googleEvent,
              modelId,
              requestId,
              hasPriorToolCalls,
            );
            if (!chunk) continue;

            const choice = chunk.choices?.[0] as
              | {
                  delta?: {
                    content?: string;
                    reasoning_content?: string;
                    tool_calls?: Array<{
                      index: number;
                      id: string;
                      type: string;
                      function: { name: string; arguments: string };
                    }>;
                  };
                  finish_reason?: string | null;
                }
              | undefined;

            const delta = choice?.delta;

            // Reasoning
            if (delta?.reasoning_content) {
              if (!activeReasoningId) {
                activeReasoningId = `reasoning-${requestId}`;
                controller.enqueue({
                  type: "reasoning-start",
                  id: activeReasoningId,
                });
              }
              controller.enqueue({
                type: "reasoning-delta",
                id: activeReasoningId,
                delta: delta.reasoning_content,
              });
            }

            // Text
            if (delta?.content) {
              if (!activeTextId) {
                activeTextId = `text-${requestId}`;
                controller.enqueue({ type: "text-start", id: activeTextId });
              }
              controller.enqueue({
                type: "text-delta",
                id: activeTextId,
                delta: delta.content,
              });
            }

            // Tool calls
            if (delta?.tool_calls) {
              hasPriorToolCalls = true;
              for (const tc of delta.tool_calls) {
                if (!activeToolIds.has(tc.id)) {
                  activeToolIds.set(tc.id, true);
                  controller.enqueue({
                    type: "tool-input-start",
                    id: tc.id,
                    toolName: tc.function.name,
                  });
                }
                if (tc.function.arguments) {
                  controller.enqueue({
                    type: "tool-input-delta",
                    id: tc.id,
                    delta: tc.function.arguments,
                  });
                }
              }
            }

            // Finish
            if (choice?.finish_reason) {
              // Close open blocks
              if (activeReasoningId) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: activeReasoningId,
                });
                activeReasoningId = null;
              }
              if (activeTextId) {
                controller.enqueue({ type: "text-end", id: activeTextId });
                activeTextId = null;
              }
              for (const id of activeToolIds.keys()) {
                controller.enqueue({ type: "tool-input-end", id });
              }
              activeToolIds.clear();

              const rawReason = choice.finish_reason;
              const unified =
                rawReason === "stop"
                  ? ("stop" as const)
                  : rawReason === "length"
                    ? ("length" as const)
                    : rawReason === "content_filter"
                      ? ("content-filter" as const)
                      : rawReason === "tool_calls"
                        ? ("tool-calls" as const)
                        : ("other" as const);

              const usage = chunk.usage as
                | {
                    prompt_tokens?: number;
                    completion_tokens?: number;
                  }
                | undefined;

              controller.enqueue({
                type: "finish",
                finishReason: { unified, raw: rawReason ?? undefined },
                usage: {
                  inputTokens: {
                    total: usage?.prompt_tokens,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: usage?.completion_tokens,
                    text: undefined,
                    reasoning: undefined,
                  },
                },
              });
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

const SANDBOX_ENDPOINT =
  "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";

export function createAntigravityProxyProvider({
  account,
}: {
  account: AntigravityAccount;
}): ProviderV3 {
  return {
    specificationVersion: "v3",
    languageModel(modelId) {
      return {
        specificationVersion: "v3",
        provider: "antigravity-proxy",
        modelId,
        supportedUrls: {},

        async doGenerate() {
          throw new Error("Only streaming is supported by this provider.");
        },

        async doStream(options: LanguageModelV3CallOptions) {
          const { accessToken, projectId, fingerprint } =
            await getValidToken(account);

          const messages = promptToOpenAIMessages(options.prompt);

          const tools: unknown[] | undefined = options.tools
            ?.filter(
              (t): t is LanguageModelV3FunctionTool => t.type === "function",
            )
            .map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              },
            }));

          const openaiBody: Record<string, unknown> = {
            model: modelId,
            messages,
            stream: true,
            ...(options.maxOutputTokens != null
              ? { max_tokens: options.maxOutputTokens }
              : {}),
            ...(options.temperature != null
              ? { temperature: options.temperature }
              : {}),
            ...(options.topP != null ? { top_p: options.topP } : {}),
            ...(options.stopSequences?.length
              ? { stop: options.stopSequences }
              : {}),
            ...(tools?.length ? { tools } : {}),
          };

          const googleBody = transformToGoogleBody(
            openaiBody,
            projectId,
            /* isCli */ false,
            /* location */ "",
            /* sessionId */ undefined,
            /* aggressive */ false,
          );

          const headers = getImpersonationHeaders(
            accessToken,
            fingerprint,
            modelId,
          );

          const response = await fetch(SANDBOX_ENDPOINT, {
            method: "POST",
            headers,
            body: JSON.stringify(googleBody),
            ...(options.abortSignal ? { signal: options.abortSignal } : {}),
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(
              `Antigravity API error ${response.status}: ${errText}`,
            );
          }

          if (!response.body) {
            throw new Error("No response body from Antigravity API.");
          }

          const requestId = `chatcmpl-${Math.random().toString(36).slice(2)}`;

          return {
            stream: createAISDKStream(response.body, modelId, requestId),
          };
        },
      };
    },

    embeddingModel() {
      throw new Error("Only language models are supported by this provider.");
    },
    imageModel() {
      throw new Error("Only language models are supported by this provider.");
    },
    rerankingModel() {
      throw new Error("Only language models are supported by this provider.");
    },
  };
}
