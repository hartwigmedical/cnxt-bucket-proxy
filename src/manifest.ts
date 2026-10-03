import { uniqueNames, type Datasource } from "./datasources.ts";
import type { StoredObject } from "./gcs.ts";

/** The formats cnxt reads as tables. Plain .json is left out: it is mostly metadata. */
export const TABLE_FILE = /\.(?:parquet|(?:csv|tsv|jsonl)(?:\.gz)?)$/;
export const TABLE_GLOB = "**.{parquet,csv,tsv,jsonl,csv.gz,tsv.gz,jsonl.gz}";
export const MAX_FILES = 1000;

/** A directory like `chromosome=chr1/`, holding one partition of a table. */
const HIVE_PARTITION = /^[^=]+=[^=]*$/;

export interface Manifest {
  name: string;
  tables: { name: string; file: string | string[] }[];
}

function words(value: string): string[] {
  return value
    .replace(TABLE_FILE, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function withoutRun(list: string[], run: string[]): string[] {
  if (run.length === 0) return list;
  const kept: string[] = [];
  for (let i = 0; i < list.length;) {
    if (run.every((word, j) => list[i + j] === word)) {
      i += run.length;
    } else {
      kept.push(list[i++]);
    }
  }
  return kept;
}

function distinct(names: string[][]): boolean {
  const joined = names.map((w) => w.join("_"));
  return new Set(joined).size === joined.length;
}

function sqlFriendly(name: string): string {
  return /^[a-z_]/.test(name) ? name : `t_${name}`;
}

/**
 * SQL names for a datasource's tables, from their paths below it. The
 * datasource's folder name and repeated words are dropped, so the same file in
 * sibling datasources gets the same name and cnxt can merge them, e.g.
 * `purple/COLO829T.purple.purity.tsv` in `COLO829T/` → `purple_purity`. Names
 * that would collide keep their full path.
 */
export function tableNames(paths: string[], folder: string): string[] {
  const own = words(folder);
  const full = paths.map(words);
  const short = full.map((w) => {
    const kept = withoutRun(w, own).filter((x, i, all) => all.indexOf(x) === i);
    return kept.length > 0 ? kept : w;
  });
  const chosen = distinct(short) ? short : full;
  return uniqueNames(chosen.map((w) => sqlFriendly(w.join("_") || "table")));
}

interface Table {
  /** The path the table's name derives from. */
  path: string;
  files: string[];
}

/**
 * One table per file, except that the files of a hive-partitioned directory
 * (`variants/chromosome=chr1/data_0.parquet`, ...) form one table together.
 */
function groupTables(paths: string[], folder: string): Table[] {
  const tables: Table[] = [];
  const partitioned = new Map<string, Table>();
  for (const path of paths) {
    const segments = path.split("/");
    const partition = segments
      .slice(0, -1)
      .findIndex((s) => HIVE_PARTITION.test(s));
    if (partition === -1) {
      tables.push({ path, files: [path] });
      continue;
    }
    const base = segments.slice(0, partition).join("/");
    const key = `${base}\0${TABLE_FILE.exec(path)?.[0]}`;
    let table = partitioned.get(key);
    if (!table) {
      table = { path: base || folder || "data", files: [] };
      partitioned.set(key, table);
      tables.push(table);
    }
    table.files.push(path);
  }
  return tables;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/%3D/g, "="))
    .join("/");
}

/** A table path below a datasource, or null if it can't be one. */
export function tablePath(segments: string[]): string | null {
  if (segments.length === 0) return null;
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  const path = segments.join("/");
  return TABLE_FILE.test(path) ? path : null;
}

export function buildManifest(
  datasource: Datasource,
  objects: StoredObject[]
): Manifest {
  const paths = objects
    .filter((o) => o.size > 0 && o.name.startsWith(datasource.prefix))
    .map((o) => o.name.slice(datasource.prefix.length))
    .filter((path) => tablePath(path.split("/")) !== null)
    .sort();
  const tables = groupTables(paths, datasource.folder);
  const names = tableNames(
    tables.map((t) => t.path),
    datasource.folder
  );
  return {
    name: datasource.name,
    tables: tables.map(({ files }, i) => ({
      name: names[i],
      file: files.length === 1 ? encodePath(files[0]) : files.map(encodePath),
    })),
  };
}
