# AI SDK Antigravity Proxy

Antigravity models through the Vercel AI SDK.

All models support the most important features, such as reasoning, tool calls, metadata like thought signatures, through the standard `generateText` and `streamText` endpoints:

| IDs                                                                                | Supported? |
| ---------------------------------------------------------------------------------- | ---------- |
| gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.5-flash-thinking, gemini-2.5-pro | ✅ Yes     |
| gemini-3-flash, gemini-3-pro, gemini-3-pro-high, gemini-3-pro-low                  | ✅ Yes     |
| gemini-3.1-pro, gemini-3.1-pro-high, gemini-3.1-pro-low                            | ✅ Yes     |
| gemini-3.5-flash-high, gemini-3.5-flash-medium, gemini-3.5-flash-low               | Unknown    |
| claude-sonnet-4-5, claude-sonnet-4-5-thinking                                      | ✅ Yes     |
| claude-sonnet-4-6, claude-sonnet-4-6-thinking, claude-opus-4-6-thinking            | ✅ Yes     |

Always follow the Antigravity [Terms of Service](https://antigravity.google/terms).

## Usage

First, get your auth credentials:

```bash
pnpm add -g @ryangarber/ai-sdk-antigravity-proxy
ai-sdk-antigravity-proxy auth
```

Then, call the provider like you would any other:

```ts
import { createAntigravityProxyProvider } from "./provider";

const provider = createAntigravityProxyProvider({
  account: {
    refreshToken: "your-refresh-token",
    projectId: "your-project-id",
    email: "user@example.com",
  },
});


// generateText
const generation = await generateText({model: provider.languageModel('gemini-3-flash'), ...});

// streamText
const stream = streamText({model: provider.languageModel('gemini-3-flash'), ...});
```

If desired, you can also capture your generated fingerprint and reuse it on subsequent runs:

```ts
// generateText
const fingerprint = generation.providerMetadata.['antigravity-proxy'].fingerprint;

// streamText
let fingerprint;
for await (const event of stream.fullStream) {
  if (event.type === 'finish') {
    fingerprint = event.providerMetadata.['antigravity-proxy'].fingerprint;
  }
}

const provider = createAntigravityProxyProvider({
  account: {
    refreshToken: "your-refresh-token",
    projectId: "your-project-id",
    email: "user@example.com",
    fingerprint: fingerprint
  },
});
```
