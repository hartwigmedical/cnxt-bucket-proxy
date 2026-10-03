import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credentials } from "./credentials.ts";
import { GcsError, HttpGcs } from "./gcs.ts";

let server: Server;
let requests: IncomingMessage[];
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let credentials: Credentials;
let gcs: HttpGcs;

beforeEach(async () => {
  requests = [];
  server = createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let token = 0;
  credentials = {
    source: "test",
    accessToken: vi.fn(async () => `token-${token}`),
    invalidate: vi.fn(() => token++),
  };
  gcs = new HttpGcs(
    credentials,
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  );
});

afterEach(() => {
  server.closeAllConnections();
  server.close();
});

function query(req: IncomingMessage) {
  return Object.fromEntries(new URL(req.url ?? "", "http://x").searchParams);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("listPrefixes", () => {
  it("follows pages", async () => {
    handler = (req, res) =>
      query(req).pageToken
        ? json(res, 200, { prefixes: ["runs/b/"] })
        : json(res, 200, { prefixes: ["runs/a/"], nextPageToken: "p2" });
    expect(await gcs.listPrefixes("my-bucket", "runs/")).toEqual([
      "runs/a/",
      "runs/b/",
    ]);
    expect(
      requests.map((r) => new URL(r.url ?? "", "http://x").pathname)
    ).toEqual(["/storage/v1/b/my-bucket/o", "/storage/v1/b/my-bucket/o"]);
    expect(query(requests[0])).toMatchObject({
      prefix: "runs/",
      delimiter: "/",
      maxResults: "1000",
    });
    expect(query(requests[1]).pageToken).toBe("p2");
    expect(requests[0].headers.authorization).toBe("Bearer token-0");
  });

  it("reports GCS's error message", async () => {
    handler = (_req, res) =>
      json(res, 403, {
        error: { code: 403, message: "me does not have storage.objects.list" },
      });
    const error = await gcs.listPrefixes("b", "").catch((e) => e);
    expect(error).toBeInstanceOf(GcsError);
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      "Failed to list gs://b/: me does not have storage.objects.list"
    );
  });

  it("retries once with a fresh token when the token is rejected", async () => {
    handler = (req, res) =>
      req.headers.authorization === "Bearer token-0"
        ? json(res, 401, { error: { message: "expired" } })
        : json(res, 200, { prefixes: ["a/"] });
    expect(await gcs.listPrefixes("b", "")).toEqual(["a/"]);
    expect(credentials.invalidate).toHaveBeenCalledOnce();
  });
});

describe("listObjects", () => {
  it("filters with matchGlob and stops at the limit", async () => {
    handler = (req, res) =>
      json(res, 200, {
        items: [
          { name: "a.csv", size: "1" },
          { name: "b.csv", size: "2" },
        ],
        nextPageToken: query(req).pageToken ? undefined : "p2",
      });
    expect(await gcs.listObjects("b", "x/", "**.csv", 3)).toEqual({
      objects: [
        { name: "a.csv", size: 1 },
        { name: "b.csv", size: 2 },
        { name: "a.csv", size: 1 },
      ],
      truncated: true,
    });
    expect(query(requests[0])).toMatchObject({
      prefix: "x/",
      matchGlob: "**.csv",
    });
    expect(await gcs.listObjects("b", "x/", "**.csv", 4)).toMatchObject({
      truncated: false,
    });
  });
});

describe("readObject", () => {
  it("requests the media with the given headers, uncompressed", async () => {
    handler = (_req, res) => {
      res.writeHead(206, { "content-range": "bytes 0-1/5" });
      res.end("ab");
    };
    const response = await gcs.readObject("b", "dir/a b#1.csv", "GET", {
      range: "bytes=0-1",
    });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("ab");
    expect(requests[0].url).toBe("/b/dir/a%20b%231.csv");
    expect(requests[0].headers).toMatchObject({
      range: "bytes=0-1",
      "accept-encoding": expect.stringMatching(/^identity(, identity)?$/),
      authorization: "Bearer token-0",
    });
  });
});
