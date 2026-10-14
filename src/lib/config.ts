import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Full endpoint URL. Defaults to https://<accountId>.r2.cloudflarestorage.com */
  endpoint?: string;
}

export function defaultEndpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export function resolvedEndpoint(creds: R2Credentials): string {
  return creds.endpoint?.trim() || defaultEndpoint(creds.accountId);
}

export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "r2n");
  return join(homedir(), ".config", "r2n");
}

export function getCredentialsPath(): string {
  return join(getConfigDir(), "credentials.json");
}

/** Env override wins over file. Supports R2_* and R2N_* prefixes. */
export function loadCredentialsFromEnv(): R2Credentials | null {
  const accountId =
    process.env.R2N_ACCOUNT_ID ?? process.env.R2_ACCOUNT_ID ?? "";
  const accessKeyId =
    process.env.R2N_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID ?? "";
  const secretAccessKey =
    process.env.R2N_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY ?? "";
  const endpoint =
    process.env.R2N_ENDPOINT ?? process.env.R2_ENDPOINT ?? undefined;
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return {
    accountId: accountId.trim(),
    accessKeyId: accessKeyId.trim(),
    secretAccessKey,
    endpoint: endpoint?.trim() || undefined,
  };
}

export async function loadCredentialsFromFile(): Promise<R2Credentials | null> {
  try {
    const raw = await readFile(getCredentialsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<R2Credentials>;
    if (!parsed.accountId || !parsed.accessKeyId || !parsed.secretAccessKey) {
      return null;
    }
    return {
      accountId: String(parsed.accountId).trim(),
      accessKeyId: String(parsed.accessKeyId).trim(),
      secretAccessKey: String(parsed.secretAccessKey),
      endpoint: parsed.endpoint?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

export type CredentialSource = "env" | "file";

export async function loadCredentials(): Promise<{
  creds: R2Credentials;
  source: CredentialSource;
} | null> {
  const fromEnv = loadCredentialsFromEnv();
  if (fromEnv) return { creds: fromEnv, source: "env" };
  const fromFile = await loadCredentialsFromFile();
  if (fromFile) return { creds: fromFile, source: "file" };
  return null;
}

export async function saveCredentials(creds: R2Credentials): Promise<string> {
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Best-effort chmod (Windows ignores mode).
  try {
    await chmod(dir, 0o700);
  } catch {
    // ignore
  }
  const path = getCredentialsPath();
  const payload = JSON.stringify(
    {
      accountId: creds.accountId,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.endpoint ? { endpoint: creds.endpoint } : {}),
    },
    null,
    2
  );
  await writeFile(path, payload + "\n", { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // ignore
  }
  return path;
}

export async function clearCredentials(): Promise<boolean> {
  try {
    await unlink(getCredentialsPath());
    return true;
  } catch {
    return false;
  }
}

export async function credentialsFileMode(): Promise<string | null> {
  try {
    const s = await stat(getCredentialsPath());
    return (s.mode & 0o777).toString(8);
  } catch {
    return null;
  }
}

export function maskSecret(secret: string): string {
  if (secret.length <= 4) return "••••";
  return `••••${secret.slice(-4)}`;
}

export function configDirForDisplay(): string {
  return getConfigDir();
}
