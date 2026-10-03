import { describe, expect, it, vi } from "vitest";
import {
  CredentialsError,
  findCredentials,
  gcloudCli,
  type Credentials,
} from "./credentials.ts";

describe("gcloudCli", () => {
  it("reuses a token for a few minutes", async () => {
    let now = 0;
    let calls = 0;
    const run = vi.fn(async () => `token-${++calls}\n`);
    const credentials = gcloudCli(run, () => now);
    expect(await credentials.accessToken()).toBe("token-1");
    expect(await credentials.accessToken()).toBe("token-1");
    expect(run).toHaveBeenCalledWith("gcloud", ["auth", "print-access-token"]);
    now = 6 * 60 * 1000;
    expect(await credentials.accessToken()).toBe("token-2");
    credentials.invalidate();
    expect(await credentials.accessToken()).toBe("token-3");
  });

  it("tries again after a failure", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("not logged in"))
      .mockResolvedValueOnce("token");
    const credentials = gcloudCli(run);
    await expect(credentials.accessToken()).rejects.toThrow("not logged in");
    expect(await credentials.accessToken()).toBe("token");
  });
});

function candidate(source: string, token: () => Promise<string>): Credentials {
  return { source, accessToken: token, invalidate: () => {} };
}

describe("findCredentials", () => {
  it("takes the first source that gives a token", async () => {
    const found = await findCredentials([
      candidate("adc", async () => {
        throw new Error("Could not load the default credentials");
      }),
      candidate("gcloud", async () => "token"),
    ]);
    expect(found.source).toBe("gcloud");
  });

  it("explains every failure", async () => {
    const error = await findCredentials([
      candidate("adc", async () => {
        throw new Error("Could not load the default credentials");
      }),
      candidate("gcloud", async () => {
        throw new Error("spawn gcloud ENOENT");
      }),
    ]).catch((e) => e);
    expect(error).toBeInstanceOf(CredentialsError);
    expect(error.message).toContain(
      "adc: Could not load the default credentials"
    );
    expect(error.message).toContain("gcloud: spawn gcloud ENOENT");
    expect(error.message).toContain("gcloud auth application-default login");
  });
});
