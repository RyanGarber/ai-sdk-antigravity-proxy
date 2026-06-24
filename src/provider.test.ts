import { describe, it, expect } from "vitest";
import { createAntigravityProxyProvider } from "./provider.js";

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
});
