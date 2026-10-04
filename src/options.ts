import { parseArgs } from "node:util";
import {
  parseGlob,
  parseLocation,
  UsageError,
  type BucketLocation,
} from "./datasources.ts";

export const DEFAULT_PORT = 3950;

export const USAGE = `Usage: cnxt-bucket-proxy <bucket> [glob] [options]

Serves a Google Cloud Storage bucket as a cnxt domain on 127.0.0.1, reading it
with your own Google credentials.

Arguments:
  bucket  Bucket name or gs:// URI, e.g. my-bucket or gs://my-bucket/some/path
  glob    Which prefixes are datasources, relative to the bucket (or path).
          '*' makes each top-level prefix a datasource, 'runs/*' each prefix
          below runs/. Without it, the whole bucket is one datasource.
          Quote it, so your shell doesn't expand it.

Options:
  -p, --port <port>      Port to listen on (default ${DEFAULT_PORT})
  -o, --origin <origin>  The origin of the cnxt that may connect, e.g.
                         https://cnxt.example.org (repeatable), or '*' for
                         any website. Asked for at launch when left out.
  -h, --help             Show this help
  -v, --version          Show the version
`;

export interface Options {
  location: BucketLocation;
  glob?: string;
  segments?: string[];
  port: number;
  origins: string[];
}

export type Command =
  { kind: "help" } | { kind: "version" } | { kind: "serve"; options: Options };

function port(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new UsageError(`--port must be a port number, got "${value}"`);
  }
  return number;
}

export const ANY_ORIGIN = "*";

function origin(value: string): string {
  if (value.trim() === ANY_ORIGIN) return ANY_ORIGIN;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:")
      return url.origin;
  } catch {
    // Reported below.
  }
  throw new UsageError(
    `"${value}" is not an origin such as https://cnxt.example.org, or '*' for any website`
  );
}

/** The origins typed at the launch prompt; nothing means any website. */
export function parseOriginAnswer(answer: string): string[] {
  const values = answer.split(/[\s,]+/).filter(Boolean);
  return values.length === 0 ? [ANY_ORIGIN] : [...new Set(values.map(origin))];
}

export function parseCommand(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: "string", short: "p" },
        origin: { type: "string", short: "o", multiple: true },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };

  if (positionals.length === 0) throw new UsageError("Missing the bucket");
  if (positionals.length > 2) {
    throw new UsageError(
      `Expected <bucket> [glob], got ${positionals.length} arguments. Quote the glob so your shell doesn't expand it, e.g. '*'`
    );
  }
  const [bucket, glob] = positionals;
  return {
    kind: "serve",
    options: {
      location: parseLocation(bucket),
      ...(glob === undefined ? {} : { glob, segments: parseGlob(glob) }),
      port: port(values.port),
      origins: [...new Set((values.origin ?? []).map(origin))],
    },
  };
}
