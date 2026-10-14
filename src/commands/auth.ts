import * as p from "@clack/prompts";
import {
  clearCredentials,
  credentialsFileMode,
  getCredentialsPath,
  loadCredentialsFromFile,
  maskSecret,
  resolvedEndpoint,
  saveCredentials,
  type R2Credentials,
} from "../lib/config.js";
import { createR2Client, testConnection } from "../lib/r2.js";

export interface AuthOptions {
  reset?: boolean;
  status?: boolean;
}

const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

function onboardingNote(): string {
  return [
    "To connect r2n you need an R2 Account API token (S3-compatible):",
    "",
    "  1. Open dash.cloudflare.com > R2 object storage > Account Details > Manage API Tokens",
    "  2. Choose Create Account API token (NOT User API token — user tokens stop",
    "     working if you are removed from the account)",
    "  3. Permissions: Admin Read & Write (required — r2n verifies via ListBuckets",
    "     and needs full browse / upload / delete)",
    "  4. Copy: Account ID, Access Key ID, Secret Access Key (secret is shown once)",
    "",
    "Docs: https://developers.cloudflare.com/r2/api/tokens/",
    "Your secret is stored only in a local 0600 file, never sent anywhere",
    "except your R2 endpoint.",
  ].join("\n");
}

export async function runAuth(options: AuthOptions = {}): Promise<void> {
  p.intro("r2n auth — connect Cloudflare R2");

  if (options.status) {
    const existing = await loadCredentialsFromFile();
    if (!existing) {
      p.note("No credentials stored yet. Run `r2n auth` to connect.", "Status");
    } else {
      const mode = await credentialsFileMode();
      p.note(
        [
          `Account ID:      ${existing.accountId}`,
          `Access Key ID:   ${existing.accessKeyId}`,
          `Secret:          ${maskSecret(existing.secretAccessKey)}`,
          `Endpoint:        ${resolvedEndpoint(existing)}`,
          `File:            ${getCredentialsPath()} (mode ${mode ?? "?"})`,
        ].join("\n"),
        "Stored credentials (file-only, single profile)"
      );
    }
    p.outro("Done.");
    return;
  }

  if (options.reset) {
    const cleared = await clearCredentials();
    p.note(
      cleared
        ? "Stored credentials removed."
        : "No stored credentials found — nothing to remove.",
      "Reset"
    );
    p.outro("Done. Run `r2n auth` to reconnect.");
    return;
  }

  const existing = await loadCredentialsFromFile();
  if (existing) {
    const overwrite = await p.confirm({
      message: `Credentials already exist for account ${existing.accountId}. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) {
      p.outro("Kept existing credentials. Run `r2n` to browse.");
      return;
    }
  }

  p.note(onboardingNote(), "How to give r2n access");

  const accountId = await p.text({
    message: "Account ID (32-char hex, found in R2 dashboard URL / overview)",
    placeholder: "abc123… (32 chars)",
    validate: (v) =>
      !v?.trim()
        ? "Account ID is required"
        : !ACCOUNT_ID_RE.test(v.trim())
          ? "Expected 32 hex characters — check the R2 dashboard"
          : undefined,
  });
  if (p.isCancel(accountId)) return p.cancel("Auth cancelled.");

  const accessKeyId = await p.text({
    message: "R2 Access Key ID (from your API token)",
    placeholder: "e.g. 8f3a…",
    validate: (v) => (!v?.trim() ? "Access Key ID is required" : undefined),
  });
  if (p.isCancel(accessKeyId)) return p.cancel("Auth cancelled.");

  const secretAccessKey = await p.password({
    message: "R2 Secret Access Key (paste — input is hidden)",
    validate: (v) => (!v ? "Secret Access Key is required" : undefined),
  });
  if (p.isCancel(secretAccessKey)) return p.cancel("Auth cancelled.");

  const endpointInput = await p.text({
    message: "Endpoint override (Enter to use default)",
    placeholder: `https://${accountId.toString().trim()}.r2.cloudflarestorage.com`,
    defaultValue: "",
  });
  if (p.isCancel(endpointInput)) return p.cancel("Auth cancelled.");

  const creds: R2Credentials = {
    accountId: accountId.toString().trim(),
    accessKeyId: accessKeyId.toString().trim(),
    secretAccessKey: secretAccessKey.toString(),
    endpoint: endpointInput.toString().trim() || undefined,
  };

  const spinner = p.spinner();
  spinner.start("Verifying — listing your R2 buckets…");
  try {
    const client = createR2Client(creds);
    const count = await testConnection(client);
    const path = await saveCredentials(creds);
    spinner.stop(
      `Connected! Found ${count} bucket${count === 1 ? "" : "s"}. Credentials saved to ${path} (0600).`
    );
  } catch (err) {
    spinner.stop("Could not connect with those credentials.");
    const message = err instanceof Error ? err.message : String(err);
    p.note(
      [`${message}`, "", "Use an R2 Account API token with Admin Read & Write (object-scoped tokens fail the ListBuckets check)."].join("\n"),
      "Verification failed — nothing was saved"
    );
    p.outro("Run `r2n auth` again to retry.");
    process.exitCode = 1;
    return;
  }

  p.outro("Success! Run `r2n` to browse your buckets.");
}
