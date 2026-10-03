import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import {
  locationUri,
  type BucketLocation,
  type Catalog,
  type Datasource,
} from "./datasources.ts";
import { GcsError, type Gcs } from "./gcs.ts";
import { buildManifest, MAX_FILES, TABLE_GLOB, tablePath } from "./manifest.ts";

/** Above this many datasources the domain offers search instead of a list. */
export const LIST_LIMIT = 200;
export const SEARCH_LIMIT = 50;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const FORWARDED_REQUEST_HEADERS = [
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
];
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
];
const EXPOSED_HEADERS =
  "Content-Range, Accept-Ranges, ETag, Content-Length, Last-Modified";

export interface DomainOptions {
  gcs: Gcs;
  location: BucketLocation;
  catalog: Catalog;
  allowedOrigins: string[];
  log?: (message: string) => void;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown
) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : data);
}

/**
 * Only answers requests addressed to a loopback host on its own port, so a
 * page can't rebind its own domain name to 127.0.0.1 and read through it.
 */
function addressedToUs(req: IncomingMessage): boolean {
  const match = /^(.+?)(?::(\d+))?$/.exec(req.headers.host ?? "");
  return (
    !!match &&
    LOOPBACK_HOSTS.has(match[1].toLowerCase()) &&
    Number(match[2] ?? 80) === req.socket.localPort
  );
}

function pathSegments(url: string): string[] {
  const { pathname } = new URL(url, "http://localhost");
  try {
    return pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "Malformed URL");
  }
}

function catalogEntry({ id, name, description }: Datasource) {
  return { id, name, description };
}

export function createDomainServer({
  gcs,
  location,
  catalog,
  allowedOrigins,
  log = console.log,
}: DomainOptions): Server {
  const origins = new Set(allowedOrigins);
  const refusedOrigins = new Set<string>();
  const uri = locationUri(location);

  async function domain() {
    const datasources = await catalog.list();
    if (datasources.length <= LIST_LIMIT) {
      return {
        name: uri,
        description: `Tables in ${uri}, read with your own Google credentials.`,
        capabilities: [],
        datasources: datasources.map(catalogEntry),
      };
    }
    return {
      name: uri,
      description: `${datasources.length} datasources in ${uri}. Search them by path.`,
      capabilities: ["search"],
    };
  }

  async function search(query: string) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (await catalog.list())
      .filter((d) => d.name.toLowerCase().includes(q))
      .slice(0, SEARCH_LIMIT)
      .map(catalogEntry);
  }

  async function datasource(id: string): Promise<Datasource> {
    const found = await catalog.get(id);
    if (!found) throw new HttpError(404, `No datasource ${id}`);
    return found;
  }

  async function manifest(id: string) {
    const source = await datasource(id);
    const listing = await gcs.listObjects(
      location.bucket,
      source.prefix,
      TABLE_GLOB,
      MAX_FILES
    );
    const built = buildManifest(source, listing.objects);
    log(
      `${source.name}: ${built.tables.length} tables${listing.truncated ? ` (only the first ${MAX_FILES} files were listed)` : ""}`
    );
    return built;
  }

  async function proxyFile(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    segments: string[]
  ) {
    const source = await datasource(id);
    const path = tablePath(segments);
    if (!path) throw new HttpError(404, "Not a table file");
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const upstream = await gcs.readObject(
      location.bucket,
      source.prefix + path,
      req.method === "HEAD" ? "HEAD" : "GET",
      headers
    );
    if (!upstream.ok && upstream.status !== 304) {
      await upstream.body?.cancel();
      const object = `gs://${location.bucket}/${source.prefix}${path}`;
      if (upstream.status === 401 || upstream.status === 403) {
        throw new HttpError(
          403,
          `Your Google credentials can't read ${object}`
        );
      }
      if (upstream.status === 404) throw new HttpError(404, `No ${object}`);
      if (upstream.status === 416)
        throw new HttpError(416, "Range Not Satisfiable");
      throw new GcsError(upstream.status, `Failed to read ${object}`);
    }
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!res.hasHeader("accept-ranges"))
      res.setHeader("accept-ranges", "bytes");
    res.writeHead(upstream.status);
    if (req.method === "HEAD" || !upstream.body) {
      await upstream.body?.cancel();
      res.end();
      return;
    }
    await pipeline(
      Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>),
      res
    ).catch(() => {
      // The client went away mid-read, which DuckDB does routinely.
    });
  }

  function intro(req: IncomingMessage, res: ServerResponse) {
    const body = [
      `cnxt domain for ${uri}`,
      "",
      `Add http://${req.headers.host} to cnxt as a custom domain.`,
      "",
    ].join("\n");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    if (!addressedToUs(req)) {
      throw new HttpError(
        403,
        "Requests must be addressed to 127.0.0.1 or localhost"
      );
    }

    const origin = req.headers.origin;
    res.setHeader("vary", "Origin");
    if (origin !== undefined) {
      if (!origins.has(origin)) {
        if (!refusedOrigins.has(origin)) {
          refusedOrigins.add(origin);
          log(
            `Refused requests from ${origin}. To allow it, restart with --origin ${origin}`
          );
        }
        throw new HttpError(403, `Origin ${origin} is not allowed`);
      }
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-expose-headers", EXPOSED_HEADERS);
    }

    if (req.method === "OPTIONS") {
      const requested = req.headers["access-control-request-headers"];
      res.writeHead(204, {
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        ...(requested ? { "access-control-allow-headers": requested } : {}),
        ...(req.headers["access-control-request-private-network"] === "true"
          ? { "access-control-allow-private-network": "true" }
          : {}),
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD, OPTIONS");
      throw new HttpError(405, "Method not allowed");
    }

    const [first, ...rest] = pathSegments(req.url ?? "/");
    if (first === "" && rest.length === 0) return intro(req, res);
    if (rest.length === 0) {
      if (first === "domain.json")
        return sendJson(req, res, 200, await domain());
      if (first === "datasources.json") {
        return sendJson(
          req,
          res,
          200,
          (await catalog.list()).map(catalogEntry)
        );
      }
      if (first === "search") {
        const q = new URL(req.url ?? "/", "http://localhost").searchParams.get(
          "q"
        );
        return sendJson(req, res, 200, await search(q ?? ""));
      }
      throw new HttpError(404, "Not found");
    }
    if (rest.length === 1 && rest[0] === "manifest.json") {
      return sendJson(req, res, 200, await manifest(first));
    }
    return proxyFile(req, res, first, rest);
  }

  return createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(req, res, err.status, { error: err.message });
        return;
      }
      const status =
        err instanceof GcsError && (err.status === 403 || err.status === 404)
          ? err.status
          : 502;
      log(
        `${req.method} ${req.url}: ${err instanceof Error ? err.message : err}`
      );
      sendJson(req, res, status, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}
