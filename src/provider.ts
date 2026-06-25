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
import { cacheSignature } from "antigravity-proxy/src/utils/cache.js";
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3FunctionTool,
  LanguageModelV3ToolResultPart,
  LanguageModelV3ToolResultOutput,
  ProviderV3,
} from "@ai-sdk/provider";
import { AntigravityProxyProviderOptions } from "./types.js";
export type { AntigravityAccount };

// ---------------------------------------------------------------------------
// Provider ID used as the namespace key in providerMetadata / providerOptions
// ---------------------------------------------------------------------------

const PROVIDER_ID = "antigravity-proxy";

// ---------------------------------------------------------------------------
// In-memory token cache — keyed by refresh token, entirely stateless.
// Lives at module scope so it persists across calls within a session while
// never touching any filesystem or external storage.
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

  // Re-use projectId from account if available, otherwise discover it once.
  const projectId =
    account.projectId ?? cached?.projectId ?? (await getProjectId(accessToken));

  // Re-use fingerprint from account if available so headers stay stable.
  const fingerprint: DeviceFingerprint =
    account.fingerprint ??
    cached?.fingerprint ??
    generateFingerprint(account.email);

  const entry: CachedToken = { accessToken, projectId, fingerprint, expiresAt };
  tokenCache.set(account.refreshToken, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Session ID: derived per-call from the conversation so that the module-level
// signature cache in cache.ts is always keyed to the right conversation.
// ---------------------------------------------------------------------------

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function deriveSessionId(
  prompt: LanguageModelV3CallOptions["prompt"],
  refreshToken: string,
): string {
  const firstMsg = prompt[0];
  const seed =
    refreshToken +
    (firstMsg
      ? typeof firstMsg.content === "string"
        ? firstMsg.content
        : JSON.stringify(firstMsg.content)
      : "");
  return djb2(seed).toString(16);
}

// ---------------------------------------------------------------------------
// Prompt conversion: AI SDK v3 → OpenAI chat messages
// Side-effect: collects (reasoningText, thoughtSignature) pairs from
// providerOptions on assistant reasoning parts so the caller can pre-populate
// the signature cache before calling transformToGoogleBody.
// ---------------------------------------------------------------------------

interface CollectedSignature {
  text: string;
  signature: string;
}

export function promptToOpenAIMessages(
  prompt: LanguageModelV3CallOptions["prompt"],
  signatureCollector: CollectedSignature[],
): unknown[] {
  const messages: unknown[] = [];

  for (const msg of prompt as LanguageModelV3Message[]) {
    if (msg.role === "system") {
      messages.push({ role: "system", content: msg.content });
      continue;
    }

    if (msg.role === "user") {
      const parts = msg.content;
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
        const text = parts
          .filter((p) => p.type === "text")
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

      // Collect reasoning content and extract any signatures from providerOptions
      const reasoningParts = msg.content.filter((p) => p.type === "reasoning");
      const reasoningContent = reasoningParts
        .map((p) => (p.type === "reasoning" ? p.text : ""))
        .join("");

      for (const p of reasoningParts) {
        if (p.type !== "reasoning") continue;
        const opts = p.providerOptions?.[PROVIDER_ID] as
          | { thoughtSignature?: string }
          | undefined;
        if (opts?.thoughtSignature) {
          signatureCollector.push({
            text: p.text,
            signature: opts.thoughtSignature,
          });
        }
      }

      const toolCallParts = msg.content.filter((p) => p.type === "tool-call");
      const toolCalls =
        toolCallParts.length > 0
          ? toolCallParts
              .map((p) => {
                if (p.type !== "tool-call") return undefined;
                return {
                  id: p.toolCallId, // may contain sig:SIG:id format — keep as-is
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
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (msg.role === "tool") {
      for (const result of msg.content) {
        if (result.type !== "tool-result") continue;
        messages.push(toolResultToOpenAIMessage(result));
      }
      continue;
    }
  }

  return messages;
}

function toolResultToOpenAIMessage(
  result: LanguageModelV3ToolResultPart,
): Record<string, unknown> {
  const base = {
    role: "tool",
    tool_call_id: result.toolCallId,
    name: result.toolName,
  };

  return {
    ...base,
    content: toolResultOutputToContent(result.output),
  };
}

function toolResultOutputToContent(
  output: LanguageModelV3ToolResultOutput,
): string | Array<{ type: string; [key: string]: unknown }> {
  switch (output.type) {
    case "text":
      return output.value;
    case "json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return output.reason ?? "Tool execution denied.";
    case "error-text":
      return output.value;
    case "error-json":
      return JSON.stringify(output.value);
    case "content":
      return output.value;
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Parse the sig: prefix that transformToGoogleBody embeds in tool call IDs.
// Format: "sig:BASE64_SIGNATURE:original_call_id"
// ---------------------------------------------------------------------------

function extractSigFromCallId(callId: string): { sig?: string; rawId: string } {
  if (callId.startsWith("sig:")) {
    const colon2 = callId.indexOf(":", 4);
    if (colon2 !== -1) {
      return { sig: callId.slice(4, colon2), rawId: callId.slice(colon2 + 1) };
    }
  }
  return { rawId: callId };
}

// ---------------------------------------------------------------------------
// Response stream: Google SSE → AI SDK v3 stream parts.
// Thought signatures are propagated via providerMetadata so clients can
// persist them and feed them back in the next turn via providerOptions.
// ---------------------------------------------------------------------------

function createAISDKStream(
  googleBody: ReadableStream<Uint8Array>,
  modelId: string,
  requestId: string,
): ReadableStream<LanguageModelV3StreamPart> {
  const decoder = new TextDecoder();
  let buffer = "";
  let hasPriorToolCalls = false;

  let activeTextId: string | null = null;
  let activeReasoningId: string | null = null;
  let pendingReasoningSignature: string | undefined;

  const activeToolIds = new Map<string, Extract<LanguageModelV3StreamPart, { type: 'tool-call' }>>();

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
            ) as {
              choices?: Array<{
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
              }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
              _signature?: string;
              _thought?: string;
            } | null;

            if (!chunk) continue;

            // Accumulate the most recent thought signature; it will be attached
            // to the reasoning-end or tool-input-start that triggers on finish.
            if (chunk._signature) {
              pendingReasoningSignature = chunk._signature;
            }

            const choice = chunk.choices?.[0];
            const delta = choice?.delta;

            // Reasoning delta
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

            // Text delta
            if (delta?.content) {
              // If we were in a reasoning block, close it before opening text
              if (activeReasoningId) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: activeReasoningId,
                  ...(pendingReasoningSignature
                    ? {
                        providerMetadata: {
                          [PROVIDER_ID]: {
                            thoughtSignature: pendingReasoningSignature,
                          },
                        },
                      }
                    : {}),
                });
                activeReasoningId = null;
                pendingReasoningSignature = undefined;
              }
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

            // Tool call deltas
            if (delta?.tool_calls) {
              hasPriorToolCalls = true;
              for (const tc of delta.tool_calls) {
                const { sig: toolSig } = extractSigFromCallId(tc.id);
                const providerMetadata = toolSig
                  ? {
                      providerMetadata: {
                        [PROVIDER_ID]: { thoughtSignature: toolSig },
                      },
                    }
                  : undefined;

                if (!activeToolIds.has(tc.id)) {
                  // The full sig:SIG:id is kept as the id for transparent round-trips;
                  // the signature is also surfaced in providerMetadata.
                  activeToolIds.set(tc.id, {
                    type: 'tool-call',
                    toolCallId: tc.id,
                    toolName: tc.function.name,
                    input: '',
                    ...providerMetadata,
                  });
                  controller.enqueue({
                    type: "tool-input-start",
                    id: tc.id,
                    toolName: tc.function.name,
                    ...providerMetadata,
                  });
                }

                if (tc.function.arguments) {
                  activeToolIds.get(tc.id)!.input += tc.function.arguments;
                  controller.enqueue({
                    type: "tool-input-delta",
                    id: tc.id,
                    delta: tc.function.arguments,
                    ...providerMetadata,
                  });
                }
              }
            }

            // Finish: close all open blocks and emit finish event
            if (choice?.finish_reason) {
              if (activeReasoningId) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: activeReasoningId,
                  ...(pendingReasoningSignature
                    ? {
                        providerMetadata: {
                          [PROVIDER_ID]: {
                            thoughtSignature: pendingReasoningSignature,
                          },
                        },
                      }
                    : {}),
                });
                activeReasoningId = null;
                pendingReasoningSignature = undefined;
              }
              if (activeTextId) {
                controller.enqueue({ type: "text-end", id: activeTextId });
                activeTextId = null;
              }
              for (const id of activeToolIds.keys()) {
                controller.enqueue({ type: "tool-input-end", id });
                controller.enqueue(activeToolIds.get(id)!);
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

              controller.enqueue({
                type: "finish",
                finishReason: { unified, raw: rawReason ?? undefined },
                usage: {
                  inputTokens: {
                    total: chunk.usage?.prompt_tokens,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: chunk.usage?.completion_tokens,
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
  test = false,
}: {
  account: AntigravityAccount;
  test?: boolean;
}): ProviderV3 {
  return {
    specificationVersion: "v3",
    languageModel(modelId) {
      return {
        specificationVersion: "v3",
        provider: PROVIDER_ID,
        modelId,
        supportedUrls: {},

        async doGenerate() {
          throw new Error("Only streaming is supported by this provider.");
        },

        async doStream(options: LanguageModelV3CallOptions) {
          const { accessToken, projectId, fingerprint } =
            test ? { accessToken: "test", projectId: "test" } : await getValidToken(account);

          // Derive a stable session ID so signatures are keyed to this conversation
          const sessionId = deriveSessionId(
            options.prompt,
            account.refreshToken,
          );

          // Convert prompt and collect any thought signatures from prior turns
          const collectedSignatures: CollectedSignature[] = [];
          const messages = promptToOpenAIMessages(
            options.prompt,
            collectedSignatures,
          );

          // Pre-populate the module-level signature cache so transformToGoogleBody
          // can attach thoughtSignature fields to assistant messages
          for (const { text, signature } of collectedSignatures) {
            cacheSignature(sessionId, text, signature);
          }

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

          const providerOptions = AntigravityProxyProviderOptions.parse(
            options.providerOptions?.[PROVIDER_ID],
          );
          const openaiBody: Record<string, unknown> = {
            model: modelId,
            messages,
            stream: true,
            thinking_budget: providerOptions?.thinkingConfig?.thinkingBudget,
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
            /* _location */ "",
            sessionId,
            /* aggressive */ false,
          );

          const headers = getImpersonationHeaders(
            accessToken,
            fingerprint,
            modelId,
          );

          if (test) {
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: "stream-start", warnings: [] });
                  controller.enqueue({ type: "text-start", id: "test" });
                  controller.enqueue({ type: "text-delta", id: "test", delta: JSON.stringify(googleBody) });
                  controller.enqueue({ type: "text-end", id: "test" });
                  controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: undefined, reasoning: undefined } } });
                  controller.close();
                },
              }),
            };
          }

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
