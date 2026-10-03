import { matchesGlob } from "node:path";
import type { Gcs } from "./gcs.ts";

export class UsageError extends Error {}

export interface BucketLocation {
  bucket: string;
  /** "" for the whole bucket, otherwise ends in "/". */
  prefix: string;
}

export interface Datasource {
  id: string;
  name: string;
  description: string;
  prefix: string;
  /** The prefix's own folder name, as it tends to recur in its file names. */
  folder: string;
}

const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

export function parseLocation(arg: string): BucketLocation {
  const match = /^(?:gs:\/\/)?([^/]+)\/*(.*)$/.exec(arg.trim());
  if (!match || !BUCKET_NAME.test(match[1])) {
    throw new UsageError(`"${arg}" is not a bucket name or gs:// URI`);
  }
  const path = match[2].replace(/\/+$/, "");
  return { bucket: match[1], prefix: path ? `${path}/` : "" };
}

export function locationUri({ bucket, prefix }: BucketLocation): string {
  return `gs://${bucket}/${prefix}`;
}

export function parseGlob(glob: string): string[] {
  const segments = glob
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/");
  for (const segment of segments) {
    if (segment.includes("**")) {
      throw new UsageError(
        `"**" is not supported: datasources are prefixes at a fixed depth, e.g. "*" or "runs/*"`
      );
    }
    if (!segment || segment === "." || segment === "..") {
      throw new UsageError(`"${glob}" is not a valid prefix glob`);
    }
  }
  return segments;
}

function lastSegment(prefix: string): string {
  return prefix.replace(/\/$/, "").split("/").pop() ?? "";
}

function identifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    for (let n = 2; used.has(candidate); n++) candidate = `${name}_${n}`;
    used.add(candidate);
    return candidate;
  });
}

async function mapConcurrently<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

/** The prefixes below the location that match the glob, segment by segment. */
export async function matchingPrefixes(
  gcs: Gcs,
  location: BucketLocation,
  segments: string[]
): Promise<string[]> {
  let prefixes = [location.prefix];
  for (const segment of segments) {
    const children = await mapConcurrently(prefixes, 16, (prefix) =>
      gcs.listPrefixes(location.bucket, prefix)
    );
    prefixes = children
      .flat()
      .filter((prefix) => matchesGlob(lastSegment(prefix), segment));
  }
  return prefixes.sort();
}

export function prefixDatasources(
  location: BucketLocation,
  prefixes: string[]
): Datasource[] {
  const names = prefixes.map((prefix) =>
    prefix.slice(location.prefix.length).replace(/\/+$/, "")
  );
  const ids = uniqueNames(names.map((name) => identifier(name) || "root"));
  return prefixes.map((prefix, i) => ({
    id: ids[i],
    name: names[i],
    description: locationUri({ bucket: location.bucket, prefix }),
    prefix,
    folder: lastSegment(prefix),
  }));
}

export function wholeLocation(location: BucketLocation): Datasource {
  const name = location.prefix ? lastSegment(location.prefix) : location.bucket;
  return {
    id: identifier(name) || "root",
    name,
    description: locationUri(location),
    prefix: location.prefix,
    folder: "",
  };
}

interface Snapshot {
  datasources: Datasource[];
  byId: Map<string, Datasource>;
  loadedAt: number;
}

/**
 * The current datasources, listed again once they are older than `maxAgeMs`.
 * File reads use the snapshot as is, so DuckDB's range requests never wait for
 * a listing; only an unknown ID triggers one early.
 */
export class Catalog {
  private readonly load: () => Promise<Datasource[]>;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private snapshot?: Snapshot;
  private loading?: Promise<Snapshot>;

  constructor(
    load: () => Promise<Datasource[]>,
    maxAgeMs: number,
    now: () => number = Date.now
  ) {
    this.load = load;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
  }

  async list(): Promise<Datasource[]> {
    return (await this.current()).datasources;
  }

  async get(id: string): Promise<Datasource | undefined> {
    const snapshot = this.snapshot ?? (await this.current());
    const found = snapshot.byId.get(id);
    if (found || !this.isStale(snapshot)) return found;
    return (await this.current()).byId.get(id);
  }

  private isStale(snapshot: Snapshot): boolean {
    return this.now() - snapshot.loadedAt > this.maxAgeMs;
  }

  private current(): Promise<Snapshot> {
    if (this.snapshot && !this.isStale(this.snapshot)) {
      return Promise.resolve(this.snapshot);
    }
    this.loading ??= this.reload().finally(() => (this.loading = undefined));
    return this.loading;
  }

  private async reload(): Promise<Snapshot> {
    try {
      const datasources = await this.load();
      this.snapshot = {
        datasources,
        byId: new Map(datasources.map((d) => [d.id, d])),
        loadedAt: this.now(),
      };
    } catch (err) {
      if (!this.snapshot) throw err;
      console.warn(
        `Could not refresh the datasources, keeping the previous list: ${err instanceof Error ? err.message : err}`
      );
      this.snapshot = { ...this.snapshot, loadedAt: this.now() };
    }
    return this.snapshot;
  }
}
