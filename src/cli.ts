#!/usr/bin/env node
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import {
  CredentialsError,
  findCredentials,
  tokenAccount,
} from "./credentials.ts";
import {
  Catalog,
  locationUri,
  matchingPrefixes,
  prefixDatasources,
  UsageError,
  wholeLocation,
  type Datasource,
} from "./datasources.ts";
import { GcsError, HttpGcs, type Gcs } from "./gcs.ts";
import { buildManifest, MAX_FILES, TABLE_GLOB } from "./manifest.ts";
import { parseCommand, USAGE, type Options } from "./options.ts";
import { createDomainServer, LIST_LIMIT } from "./server.ts";

const HOST = "127.0.0.1";
const REFRESH_MS = 60 * 1000;

function version(): string {
  const file = new URL("../package.json", import.meta.url);
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string })
    .version;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "EADDRINUSE"
          ? new UsageError(`Port ${port} is in use. Pick another with --port.`)
          : err
      )
    );
    server.listen(port, HOST, resolve);
  });
}

function preview(datasources: Datasource[]): string {
  const names = datasources.slice(0, 5).map((d) => d.name);
  const more = datasources.length - names.length;
  return more > 0 ? `${names.join(", ")}, … (${more} more)` : names.join(", ");
}

async function describeDatasources(
  gcs: Gcs,
  options: Options,
  datasources: Datasource[]
): Promise<string[]> {
  const uri = locationUri(options.location);
  if (options.segments) {
    if (datasources.length === 0) {
      throw new UsageError(`No prefixes in ${uri} match '${options.glob}'`);
    }
    return [
      `${datasources.length} datasources, one per prefix matching '${options.glob}': ${preview(datasources)}`,
      ...(datasources.length > LIST_LIMIT
        ? [`Over ${LIST_LIMIT}, so cnxt shows a search box instead of a list`]
        : []),
    ];
  }
  const [whole] = datasources;
  const { objects, truncated } = await gcs.listObjects(
    options.location.bucket,
    whole.prefix,
    TABLE_GLOB,
    MAX_FILES
  );
  const tables = buildManifest(whole, objects).tables.length;
  if (tables === 0) {
    return [
      "One datasource, but no CSV, TSV, Parquet or JSONL files in it yet",
    ];
  }
  return [
    truncated
      ? `One datasource with ${tables} tables from its first ${MAX_FILES} files; cnxt will see no more`
      : `One datasource with ${tables} tables`,
  ];
}

async function serve(options: Options) {
  const { location, segments } = options;
  const credentials = await findCredentials();
  const account = await tokenAccount(await credentials.accessToken());
  const gcs = new HttpGcs(credentials);
  const catalog = new Catalog(
    segments
      ? async () =>
          prefixDatasources(
            location,
            await matchingPrefixes(gcs, location, segments)
          )
      : async () => [wholeLocation(location)],
    REFRESH_MS
  );
  const summary = await describeDatasources(gcs, options, await catalog.list());

  const server = createDomainServer({
    gcs,
    location,
    catalog,
    allowedOrigins: options.origins,
  });
  await listen(server, options.port);

  console.log(
    [
      `Serving ${locationUri(location)} as a cnxt domain`,
      ...summary.map((line) => `  ${line}`),
      `  Reading as ${account ?? "you"} (${credentials.source})`,
      "",
      "Add it in cnxt as a custom domain:",
      `  Base URL  http://${HOST}:${options.port}`,
      "  Auth      None",
      "",
      "cnxt may connect from:",
      ...options.origins.map((origin) => `  ${origin}`),
      "Allow another with --origin. Press Ctrl+C to stop.",
      "",
    ].join("\n")
  );
}

async function main() {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(USAGE);
  } else if (command.kind === "version") {
    console.log(version());
  } else {
    await serve(command.options);
  }
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(
      `cnxt-bucket-proxy: ${err.message}\nSee cnxt-bucket-proxy --help.`
    );
    process.exit(2);
  }
  if (err instanceof CredentialsError || err instanceof GcsError) {
    console.error(`cnxt-bucket-proxy: ${err.message}`);
    process.exit(1);
  }
  throw err;
});
