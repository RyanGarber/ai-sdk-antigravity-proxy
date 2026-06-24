# AI SDK Antigravity Proxy

Antigravity models through the Vercel AI SDK. Only `streamText` is supported at this time.

Note:

- This project is purely for educational purposes and is not recommended for real use.
- Always follow the Antigravity [Terms of Service](https://antigravity.google/terms).

## Usage

First, get your auth credentials:

```bash
pnpm install
pnpm tsx src/cli.ts auth
```

Then, call the provider like you would any other:

```ts
import {createAntigravityProxyProvider} from "./provider";

const agy = createAntigravityProxyProvider({
    account: {
        refreshToken: 'your-refresh-token',
        projectId: 'your-project-id',
        email: 'user@example.com',
        // lastUsed: 0,
        // tokenUsage: 0,
        // healthScore: 100,
    }
})
```
