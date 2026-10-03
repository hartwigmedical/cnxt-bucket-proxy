import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GoogleAuth } from "google-auth-library";

const READ_ONLY_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
const GCLOUD_TOKEN_TTL_MS = 5 * 60 * 1000;

export interface Credentials {
  /** How the token was obtained, for the startup message. */
  source: string;
  accessToken(): Promise<string>;
  /** Forget a token that GCS rejected, so the next call gets a fresh one. */
  invalidate(): void;
}

export class CredentialsError extends Error {}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function applicationDefault(): Credentials {
  const auth = new GoogleAuth({ scopes: READ_ONLY_SCOPE });
  return {
    source: "Application Default Credentials",
    async accessToken() {
      const token = await auth.getAccessToken();
      if (!token)
        throw new Error("Application Default Credentials gave no token");
      return token;
    },
    invalidate() {},
  };
}

type RunCommand = (command: string, args: string[]) => Promise<string>;

const run: RunCommand = async (command, args) =>
  (await promisify(execFile)(command, args)).stdout;

export function gcloudCli(
  runCommand: RunCommand = run,
  now: () => number = Date.now
): Credentials {
  let cached: { token: Promise<string>; fetchedAt: number } | undefined;
  return {
    source: "gcloud auth login",
    accessToken() {
      if (!cached || now() - cached.fetchedAt > GCLOUD_TOKEN_TTL_MS) {
        const token = runCommand("gcloud", ["auth", "print-access-token"]).then(
          (stdout) => stdout.trim()
        );
        cached = { token, fetchedAt: now() };
        token.catch(() => {
          if (cached?.token === token) cached = undefined;
        });
      }
      return cached.token;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

/**
 * The caller's own Google credentials: Application Default Credentials when
 * set up, otherwise the account `gcloud auth login` signed in.
 */
export async function findCredentials(
  candidates: Credentials[] = [applicationDefault(), gcloudCli()]
): Promise<Credentials> {
  const failures: string[] = [];
  for (const credentials of candidates) {
    try {
      await credentials.accessToken();
      return credentials;
    } catch (err) {
      failures.push(`  ${credentials.source}: ${message(err).trim()}`);
    }
  }
  throw new CredentialsError(
    [
      "No usable Google credentials found:",
      ...failures,
      "Run `gcloud auth application-default login` (or `gcloud auth login`) and try again.",
    ].join("\n")
  );
}

/** The account a token belongs to, or undefined if Google won't say. */
export async function tokenAccount(token: string): Promise<string | undefined> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/tokeninfo", {
      method: "POST",
      body: new URLSearchParams({ access_token: token }),
    });
    if (!response.ok) return undefined;
    return ((await response.json()) as { email?: string }).email;
  } catch {
    return undefined;
  }
}
