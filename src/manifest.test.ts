import { describe, expect, it } from "vitest";
import type { Datasource } from "./datasources.ts";
import { buildManifest, tableNames, tablePath } from "./manifest.ts";

function datasource(prefix: string, folder: string): Datasource {
  return { id: "ds", name: "ds", description: "", prefix, folder };
}

describe("tableNames", () => {
  it("drops the datasource's folder name and repeated words", () => {
    expect(
      tableNames(
        [
          "purple/COLO829T.purple.purity.tsv",
          "purple/COLO829T.purple.cnv.somatic.tsv",
          "linx/COLO829T.linx.svs.tsv",
        ],
        "COLO829T"
      )
    ).toEqual(["purple_purity", "purple_cnv_somatic", "linx_svs"]);
  });

  it("drops the folder name only as a whole run of words", () => {
    expect(tableNames(["sample_001_metrics.csv"], "sample-001")).toEqual([
      "metrics",
    ]);
    expect(tableNames(["run_metrics.csv"], "COLO829-run-2")).toEqual([
      "run_metrics",
    ]);
  });

  it("keeps a name that would otherwise be empty", () => {
    expect(tableNames(["COLO829T.tsv", "other.tsv"], "COLO829T")).toEqual([
      "colo829t",
      "other",
    ]);
  });

  it("falls back to full paths when short names collide", () => {
    expect(tableNames(["a/x.a.tsv", "a/x.tsv"], "")).toEqual(["a_x_a", "a_x"]);
  });

  it("makes names valid SQL identifiers", () => {
    expect(tableNames(["2024/counts.csv", "x.csv", "x.csv.gz"], "")).toEqual([
      "t_2024_counts",
      "x",
      "x_2",
    ]);
  });
});

describe("tablePath", () => {
  it("accepts table files", () => {
    expect(tablePath(["a", "b.parquet"])).toBe("a/b.parquet");
    expect(tablePath(["b.tsv.gz"])).toBe("b.tsv.gz");
    expect(tablePath(["b.jsonl"])).toBe("b.jsonl");
  });

  it("rejects other files and odd segments", () => {
    expect(tablePath([])).toBeNull();
    expect(tablePath(["notes.json"])).toBeNull();
    expect(tablePath(["report.pdf"])).toBeNull();
    expect(tablePath(["..", "b.csv"])).toBeNull();
    expect(tablePath(["a", "", "b.csv"])).toBeNull();
    expect(tablePath([".", "b.csv"])).toBeNull();
  });
});

describe("buildManifest", () => {
  it("lists the table files below the datasource", () => {
    const manifest = buildManifest(datasource("runs/S1/", "S1"), [
      { name: "runs/S1/b.csv", size: 10 },
      { name: "runs/S1/a dir/S1.a.tsv", size: 10 },
      { name: "runs/S1/empty.csv", size: 0 },
      { name: "runs/S1/odd//x.csv", size: 10 },
      { name: "runs/S1/notes.json", size: 10 },
      { name: "runs/S2/c.csv", size: 10 },
    ]);
    expect(manifest).toEqual({
      name: "ds",
      tables: [
        { name: "a_dir", file: "a%20dir/S1.a.tsv" },
        { name: "b", file: "b.csv" },
      ],
    });
  });

  it("reads a hive-partitioned directory as one table", () => {
    const manifest = buildManifest(datasource("", ""), [
      { name: "scores/chromosome=chr1/data_0.parquet", size: 10 },
      { name: "scores/chromosome=chr1/data_1.parquet", size: 10 },
      { name: "scores/chromosome=chr2/data_0.parquet", size: 10 },
      { name: "scores/readme.csv", size: 10 },
    ]);
    expect(manifest.tables).toEqual([
      {
        name: "scores",
        file: [
          "scores/chromosome=chr1/data_0.parquet",
          "scores/chromosome=chr1/data_1.parquet",
          "scores/chromosome=chr2/data_0.parquet",
        ],
      },
      { name: "scores_readme", file: "scores/readme.csv" },
    ]);
  });

  it("names a datasource-wide partitioned table after the datasource", () => {
    const manifest = buildManifest(datasource("scores/", "scores"), [
      { name: "scores/year=2024/data_0.parquet", size: 10 },
      { name: "scores/year=2025/data_0.parquet", size: 10 },
    ]);
    expect(manifest.tables).toEqual([
      {
        name: "scores",
        file: ["year=2024/data_0.parquet", "year=2025/data_0.parquet"],
      },
    ]);
  });
});
