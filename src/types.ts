import { z } from "zod";

export const AntigravityProxyModel = z.enum([
  "claude-sonnet-4-6",
  "claude-sonnet-4-6-thinking",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-thinking",
  "claude-opus-4-6-thinking",
  "gemini-3.5-flash-high",
  "gemini-3.5-flash-medium",
  "gemini-3.5-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gemini-3.1-pro",
  "gemini-3.1-pro-preview",
  "gemini-3-flash",
  "gemini-3-pro-high",
  "gemini-3-pro-low",
  "gemini-3-pro",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-thinking",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
]);
export type AntigravityProxyModel = z.infer<typeof AntigravityProxyModel>;

export const AntigravityProxyProviderOptions = z
  .looseObject({
    thinkingConfig: z
      .looseObject({
        includeThoughts: z.boolean().optional(),
        thinkingLevel: z.enum(["minimal", "low", "medium", "high"]).optional(),
        thinkingBudget: z.number().optional(),
      })
      .optional(),
  })
  .optional();
export type AntigravityProxyProviderOptions = z.infer<
  typeof AntigravityProxyProviderOptions
>;
