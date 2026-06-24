import {
  exchangeCode,
  generateAuthUrl,
  getProjectId,
  getUserEmail,
} from "antigravity-proxy/src/auth/oauth.js";
import { Command } from "@commander-js/extra-typings";
import { createServer } from "node:http";
import * as child_process from "node:child_process";
import packageJson from "../package.json" with { type: "json" };
import { streamText } from "ai";
import { createAntigravityProxyProvider } from "./provider.js";
import { writeFileSync } from "node:fs";

if (typeof process !== "undefined") {
  const program = new Command()
    .version(packageJson.version)
    .description(packageJson.description);

  program
    .command("auth")
    .description("Get Antigravity credentials")
    .action(async () => {
      const authUrl = generateAuthUrl();

      console.log(`Your sign in link: ${authUrl}`);
      console.log("Waiting for you to sign in...");

      // open in browser
      child_process.exec(`open ${authUrl}`);

      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "", `http://${req.headers.host}`);

        if (url.pathname === "/oauth-callback") {
          console.log("Authenticating...");

          const code = url.searchParams.get("code");
          if (!code) {
            console.error("Error: no code received");
            return;
          }

          const auth = await exchangeCode(code);
          if (!auth.refresh_token) {
            console.error("Error: no refresh token received");
            return;
          }

          const email = await getUserEmail(auth.access_token);
          const projectId = await getProjectId(auth.access_token);

          console.log();
          console.log("-------------------");
          console.log(`Access Token: ${auth.access_token}`);
          console.log(`Refresh Token: ${auth.refresh_token}`);
          console.log(`Email: ${email}`);
          console.log(`Project ID: ${projectId}`);
          console.log("-------------------");
          console.log();

          console.log(
            `Use it in a command:\n  --refresh-token "${auth.refresh_token}" --email "${email}" --project-id "${projectId}"`,
          );

          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("You may now close this window.\n");

          server.close();
          return;
        }

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("200\n");
      });

      server.listen(3000);
    });

  program
    .command("call")
    .argument("model <model>")
    .argument("[prompt...]", "Prompt to send to the model")
    .option(
      "-r, --refresh-token <value>",
      "Refresh token to use for authentication",
    )
    .option("-e, --email <value>", "Email address to use for authentication")
    .option("-p, --project-id <value>", "Project ID to use for authentication")
    .option("-o, --output <file>", "Log raw output to a file")
    .option("-v, --verbose", "Log raw output to the console")
    .description("Call a model")
    .action(
      async (
        model,
        prompt,
        { refreshToken, email, projectId, output, verbose },
      ) => {
        if (!refreshToken || !email) {
          console.error("Error: a refresh token and an email are required");
          return;
        }

        console.log(`Calling model: ${model}`);
        const stream = streamText({
          model: createAntigravityProxyProvider({
            account: {
              refreshToken,
              email,
              projectId,
              healthScore: 100,
              tokenUsage: 0,
              lastUsed: 0,
            },
          }).languageModel(model),
          messages: [{ role: "user", content: prompt.join(" ") }],
        });

        const raw = [];
        for await (const chunk of stream.fullStream) {
          raw.push(chunk);
          if (verbose) {
            console.log(chunk);
            continue;
          }

          if (chunk.type === "reasoning-start") {
            console.log();
            console.log("--- Thinking... ---");
          } else if (chunk.type === "reasoning-delta") {
            console.log(chunk.text);
          } else if (chunk.type === "reasoning-end") {
            console.log("-------------------");
            console.log();
          }

          if (chunk.type === "text-start") {
            console.log();
            console.log("-- Generating... --");
          } else if (chunk.type === "text-delta") {
            console.log(chunk.text);
          } else if (chunk.type === "text-end") {
            console.log("-------------------");
            console.log();
          }

          if (chunk.type === "error") {
            console.error("Error:", chunk.error);
          }

          if (chunk.type === "finish-step") {
            console.log(`Done (${chunk.usage.totalTokens} tokens)`);
          }
        }

        if (output) {
          writeFileSync(output, JSON.stringify(raw, null, 2));
        }
      },
    );

  program.parse();
}
