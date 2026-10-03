import { once } from "node:events";
import type { Server } from "node:http";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Catalog, type Datasource } from "./datasources.ts";
import type { Gcs } from "./gcs.ts";
import { createDomainServer, LIST_LIMIT } from "./server.ts";

const ORIGIN = "https://cnxt.test";

function datasource(id: string): Datasource {
  return {
    id,
    name: `runs/${id}`,
    description: `gs://bucket/runs/${id}/`,
    prefix: `runs/${id}/`,
    folder: id,
  };
}

let gcs: Gcs;
let server: Server;
let base: string;
let logs: string[];

async function json(response: Response | Promise<Response>): Promise<any> {
  return (await response).json();
}

async function start(datasources: Datasource[]) {
  logs = [];
  server = createDomainServer({
    gcs,
    location: { bucket: "bucket", prefix: "" },
    catalog: new Catalog(async () => datasources, 60_000),
    allowedOrigins: [ORIGIN],
    log: (message) => logs.push(message),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  gcs = {
    listPrefixes: vi.fn(),
    listObjects: vi.fn(async () => ({
      objects: [
        { name: "runs/S1/S1.purity.tsv", size: 10 },
        { name: "runs/S1/report.pdf", size: 10 },
      ],
      truncated: false,
    })),
    readObject: vi.fn(
      async () =>
        new Response("abc", {
          status: 206,
          headers: {
            "content-type": "text/tab-separated-values",
            "content-length": "3",
            "content-range": "bytes 0-2/10",
            etag: '"e1"',
            "x-goog-generation": "1",
          },
        })
    ),
  };
  await start([datasource("S1"), datasource("S2")]);
});

afterEach(async () => {
  server.closeAllConnections();
  server.close();
});

describe("domain", () => {
  it("lists the datasources inline", async () => {
    const response = await fetch(`${base}/domain.json`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "gs://bucket/",
      description: expect.any(String),
      capabilities: [],
      datasources: [
        {
          id: "S1",
          name: "runs/S1",
          description: "gs://bucket/runs/S1/",
        },
        {
          id: "S2",
          name: "runs/S2",
          description: "gs://bucket/runs/S2/",
        },
      ],
    });
  });

  it("offers search instead once there are too many to list", async () => {
    server.closeAllConnections();
    server.close();
    await start(
      Array.from({ length: LIST_LIMIT + 1 }, (_, i) => datasource(`S${i}`))
    );
    const domain = await json(fetch(`${base}/domain.json`));
    expect(domain.capabilities).toEqual(["search"]);
    expect(domain.datasources).toBeUndefined();

    const results = await json(fetch(`${base}/search?q=s19`));
    expect(results.map((r: Datasource) => r.id)).toEqual([
      "S19",
      ...Array.from({ length: 10 }, (_, i) => `S19${i}`),
    ]);
    expect(await json(fetch(`${base}/search?q=%20`))).toEqual([]);
  });

  it("serves the legacy datasources.json", async () => {
    const list = await json(fetch(`${base}/datasources.json`));
    expect(list.map((d: Datasource) => d.id)).toEqual(["S1", "S2"]);
  });
});

describe("manifest", () => {
  it("lists the datasource's tables", async () => {
    const response = await fetch(`${base}/S1/manifest.json`);
    expect(await response.json()).toEqual({
      name: "runs/S1",
      tables: [{ name: "purity", file: "S1.purity.tsv" }],
    });
    expect(gcs.listObjects).toHaveBeenCalledWith(
      "bucket",
      "runs/S1/",
      expect.stringContaining("parquet"),
      expect.any(Number)
    );
  });

  it("404s for an unknown datasource", async () => {
    expect((await fetch(`${base}/S9/manifest.json`)).status).toBe(404);
    expect(gcs.listObjects).not.toHaveBeenCalled();
  });

  it("passes GCS permission errors on", async () => {
    const { GcsError } = await import("./gcs.ts");
    vi.mocked(gcs.listObjects).mockRejectedValue(
      new GcsError(403, "Failed to list gs://bucket/runs/S1/: denied")
    );
    const response = await fetch(`${base}/S1/manifest.json`);
    expect(response.status).toBe(403);
    expect((await json(response)).error).toContain("denied");
  });
});

describe("files", () => {
  it("streams the object with range and conditional headers passed through", async () => {
    const response = await fetch(`${base}/S1/sub%20dir/x.tsv`, {
      headers: { range: "bytes=0-2", "if-none-match": '"e0"', cookie: "a=b" },
    });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("abc");
    expect(response.headers.get("content-range")).toBe("bytes 0-2/10");
    expect(response.headers.get("etag")).toBe('"e1"');
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("x-goog-generation")).toBeNull();
    expect(gcs.readObject).toHaveBeenCalledWith(
      "bucket",
      "runs/S1/sub dir/x.tsv",
      "GET",
      { range: "bytes=0-2", "if-none-match": '"e0"' }
    );
  });

  it("answers HEAD without a body", async () => {
    const response = await fetch(`${base}/S1/x.tsv`, { method: "HEAD" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("3");
    expect(gcs.readObject).toHaveBeenCalledWith(
      "bucket",
      "runs/S1/x.tsv",
      "HEAD",
      {}
    );
  });

  it("only serves table files inside a known datasource", async () => {
    for (const path of ["/S1/report.pdf", "/S9/x.tsv", "/S1/a//x.tsv"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect(gcs.readObject).not.toHaveBeenCalled();
  });

  it("explains GCS refusals", async () => {
    vi.mocked(gcs.readObject).mockResolvedValue(
      new Response("<Error/>", { status: 403 })
    );
    const response = await fetch(`${base}/S1/x.tsv`);
    expect(response.status).toBe(403);
    expect((await json(response)).error).toBe(
      "Your Google credentials can't read gs://bucket/runs/S1/x.tsv"
    );
  });
});

describe("access", () => {
  it("answers CORS preflights for allowed origins", async () => {
    const response = await fetch(`${base}/S1/x.tsv`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "range,authorization",
        "access-control-request-private-network": "true",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "range,authorization"
    );
    expect(response.headers.get("access-control-allow-private-network")).toBe(
      "true"
    );
  });

  it("exposes the range headers to allowed origins", async () => {
    const response = await fetch(`${base}/S1/x.tsv`, {
      headers: { origin: ORIGIN },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-expose-headers")).toContain(
      "Content-Range"
    );
  });

  it("refuses other origins, and says once how to allow them", async () => {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/S1/x.tsv`, {
        headers: { origin: "https://evil.test" },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(gcs.readObject).not.toHaveBeenCalled();
    expect(logs).toEqual([
      "Refused requests from https://evil.test. To allow it, restart with --origin https://evil.test",
    ]);
  });

  it("refuses requests addressed to another host name", async () => {
    const port = (server.address() as AddressInfo).port;
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        request(`${base}/domain.json`, { headers: { host } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        })
          .on("error", reject)
          .end();
      });
    expect(await status(`evil.test:${port}`)).toBe(403);
    expect(await status("127.0.0.1:1")).toBe(403);
    expect(await status("localhost")).toBe(403);
    expect(await status(`localhost:${port}`)).toBe(200);
    expect(await status(`[::1]:${port}`)).toBe(200);
  });

  it("only answers GET, HEAD and OPTIONS", async () => {
    const response = await fetch(`${base}/domain.json`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});
