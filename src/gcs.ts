import type { Credentials } from "./credentials.ts";

const STORAGE_URL = "https://storage.googleapis.com";

export class GcsError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface StoredObject {
  name: string;
  size: number;
}

export interface ObjectListing {
  objects: StoredObject[];
  truncated: boolean;
}

export interface Gcs {
  /** The prefixes directly below `prefix`, each ending in "/". */
  listPrefixes(bucket: string, prefix: string): Promise<string[]>;
  /** Up to `limit` objects below `prefix` whose full name matches `matchGlob`. */
  listObjects(
    bucket: string,
    prefix: string,
    matchGlob: string,
    limit: number
  ): Promise<ObjectListing>;
  /** The object's media as GCS serves it for the given request headers. */
  readObject(
    bucket: string,
    name: string,
    method: "GET" | "HEAD",
    headers: Record<string, string>
  ): Promise<Response>;
}

interface ListResponse {
  prefixes?: string[];
  items?: { name: string; size: string }[];
  nextPageToken?: string;
}

async function errorFrom(response: Response, action: string) {
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? detail;
  } catch {
    // Not a JSON API error body; the status text has to do.
  }
  return new GcsError(response.status, `Failed to ${action}: ${detail}`);
}

export class HttpGcs implements Gcs {
  private readonly credentials: Credentials;
  private readonly baseUrl: string;

  constructor(credentials: Credentials, baseUrl = STORAGE_URL) {
    this.credentials = credentials;
    this.baseUrl = baseUrl;
  }

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async () =>
      fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${await this.credentials.accessToken()}`,
        },
      });
    const response = await attempt();
    if (response.status !== 401) return response;
    await response.body?.cancel();
    this.credentials.invalidate();
    return attempt();
  }

  private async *pages(bucket: string, params: Record<string, string>) {
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ ...params, maxResults: "1000" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.fetch(
        `${this.baseUrl}/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`
      );
      if (!response.ok) {
        throw await errorFrom(response, `list gs://${bucket}/${params.prefix}`);
      }
      const page = (await response.json()) as ListResponse;
      yield page;
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  async listPrefixes(bucket: string, prefix: string): Promise<string[]> {
    const prefixes: string[] = [];
    for await (const page of this.pages(bucket, {
      prefix,
      delimiter: "/",
      fields: "prefixes,nextPageToken",
    })) {
      prefixes.push(...(page.prefixes ?? []));
    }
    return prefixes;
  }

  async listObjects(
    bucket: string,
    prefix: string,
    matchGlob: string,
    limit: number
  ): Promise<ObjectListing> {
    const objects: StoredObject[] = [];
    for await (const page of this.pages(bucket, {
      prefix,
      matchGlob,
      fields: "items(name,size),nextPageToken",
    })) {
      for (const item of page.items ?? []) {
        if (objects.length === limit) return { objects, truncated: true };
        objects.push({ name: item.name, size: Number(item.size) });
      }
    }
    return { objects, truncated: false };
  }

  readObject(
    bucket: string,
    name: string,
    method: "GET" | "HEAD",
    headers: Record<string, string>
  ): Promise<Response> {
    const path = [bucket, ...name.split("/")].map(encodeURIComponent).join("/");
    return this.fetch(`${this.baseUrl}/${path}`, {
      method,
      // identity: fetch would otherwise silently decompress gzip-encoded
      // objects while the proxy forwards their compressed Content-Length.
      headers: { ...headers, "accept-encoding": "identity" },
    });
  }
}
