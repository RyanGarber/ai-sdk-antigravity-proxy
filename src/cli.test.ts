import { describe, expect, it } from "vitest";
import * as child_process from "node:child_process";

describe("cli", () => {
  it("safely prints help", async () => {
    const output = child_process.execSync("pnpm tsx ./src/cli.ts --help", {
      stdio: "inherit",
    });
    expect(output).toBeDefined();
  });
});
