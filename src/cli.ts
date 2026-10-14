import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { runAuth } from "./commands/auth.js";
import { loadCredentials } from "./lib/config.js";
import { createR2Client } from "./lib/r2.js";
import { App } from "./ui/App.js";

const VERSION = "0.1.0";

async function launchNavigator(): Promise<void> {
  const loaded = await loadCredentials();
  if (!loaded) {
    console.error("No R2 credentials found.");
    console.error("Run `r2n auth` first to connect your account, then run `r2n`.");
    process.exitCode = 1;
    return;
  }
  if (loaded.source === "env") {
    console.error("Using R2 credentials from environment variables.");
  }
  const client = createR2Client(loaded.creds);
  const { waitUntilExit } = render(React.createElement(App, { client }));
  await waitUntilExit();
}

const program = new Command();
program
  .name("r2n")
  .description("Interactive terminal navigator for Cloudflare R2")
  .version(VERSION);

program
  .command("auth")
  .description("Connect your Cloudflare R2 account (stores tokens in a local 0600 file)")
  .option("--status", "Show stored credential status")
  .option("--reset", "Remove stored credentials")
  .action(async (options: { status?: boolean; reset?: boolean }) => {
    await runAuth(options);
  });

program
  .command("logout")
  .description("Remove stored R2 credentials")
  .action(async () => {
    await runAuth({ reset: true });
  });

// Default: `r2n` with no subcommand opens the navigator.
program.action(async () => {
  await launchNavigator();
});

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
