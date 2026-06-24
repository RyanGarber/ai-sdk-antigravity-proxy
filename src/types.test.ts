import { describe, expect, it } from "vitest";
import { AntigravityProxyProviderOptions } from "./types.js";

describe("types", () => {
  it("safely parses providerOptions", () => {
    expect(() =>
      AntigravityProxyProviderOptions.parse(undefined),
    ).not.toThrow();
    expect(() => AntigravityProxyProviderOptions.parse({})).not.toThrow();
    expect(() =>
      AntigravityProxyProviderOptions.parse({ thinkingConfig: undefined }),
    ).not.toThrow();
    expect(() =>
      AntigravityProxyProviderOptions.parse({
        thinkingConfig: { thinkingBudget: 5000 },
      }),
    ).not.toThrow();
    expect(() =>
      AntigravityProxyProviderOptions.parse({
        thinkingConfig: { thinkingBudget: "xyz" },
      }),
    ).toThrow();
    expect(() =>
      AntigravityProxyProviderOptions.parse({
        thinkingConfig: { thinkingLevel: "xyz" },
      }),
    ).toThrow();
  });
});
