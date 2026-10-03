import { describe, expect, it, vi } from "vitest";
import {
  Catalog,
  matchingPrefixes,
  parseGlob,
  parseLocation,
  prefixDatasources,
  uniqueNames,
  UsageError,
  wholeLocation,
  type Datasource,
} from "./datasources.ts";
import type { Gcs } from "./gcs.ts";

describe("parseLocation", () => {
  it("accepts a bucket name or gs:// URI", () => {
    expect(parseLocation("my-bucket")).toEqual({
      bucket: "my-bucket",
      prefix: "",
    });
    expect(parseLocation("gs://my-bucket/")).toEqual({
      bucket: "my-bucket",
      prefix: "",
    });
    expect(parseLocation("gs://my-bucket/runs/2024/")).toEqual({
      bucket: "my-bucket",
      prefix: "runs/2024/",
    });
  });

  it("rejects what can't be a bucket", () => {
    expect(() => parseLocation("gs://")).toThrow(UsageError);
    expect(() => parseLocation("My_Bucket")).toThrow(UsageError);
    expect(() => parseLocation("")).toThrow(UsageError);
  });
});

describe("parseGlob", () => {
  it("splits a glob into segments", () => {
    expect(parseGlob("*")).toEqual(["*"]);
    expect(parseGlob("runs/*/")).toEqual(["runs", "*"]);
  });

  it("rejects ** and empty segments", () => {
    expect(() => parseGlob("**")).toThrow(/not supported/);
    expect(() => parseGlob("runs/**/x")).toThrow(/not supported/);
    expect(() => parseGlob("a//b")).toThrow(UsageError);
    expect(() => parseGlob("")).toThrow(UsageError);
    expect(() => parseGlob("../x")).toThrow(UsageError);
  });
});

function fakeGcs(tree: Record<string, string[]>): Gcs {
  return {
    listPrefixes: vi.fn(async (_bucket: string, prefix: string) =>
      (tree[prefix] ?? []).map((child) => `${prefix}${child}/`)
    ),
    listObjects: vi.fn(),
    readObject: vi.fn(),
  };
}

describe("matchingPrefixes", () => {
  const tree = {
    "": ["runs", "reference", ".hidden"],
    "runs/": ["COLO829", "COLO830", "tmp"],
    "reference/": ["ensembl"],
  };

  it("matches one segment per level", async () => {
    const gcs = fakeGcs(tree);
    const location = { bucket: "b", prefix: "" };
    expect(await matchingPrefixes(gcs, location, ["*"])).toEqual([
      "reference/",
      "runs/",
    ]);
    expect(await matchingPrefixes(gcs, location, ["runs", "COLO*"])).toEqual([
      "runs/COLO829/",
      "runs/COLO830/",
    ]);
    expect(await matchingPrefixes(gcs, location, ["*", "*"])).toEqual([
      "reference/ensembl/",
      "runs/COLO829/",
      "runs/COLO830/",
      "runs/tmp/",
    ]);
  });

  it("starts below the location's prefix", async () => {
    const gcs = fakeGcs(tree);
    expect(
      await matchingPrefixes(gcs, { bucket: "b", prefix: "runs/" }, [
        "{COLO829,tmp}",
      ])
    ).toEqual(["runs/COLO829/", "runs/tmp/"]);
  });
});

describe("datasources", () => {
  it("derives IDs and names from the prefixes below the location", () => {
    const location = { bucket: "b", prefix: "data/" };
    expect(
      prefixDatasources(location, [
        "data/runs/a b/",
        "data/runs/a_b/",
        "data/x.y/",
      ])
    ).toEqual([
      {
        id: "runs_a_b",
        name: "runs/a b",
        description: "gs://b/data/runs/a b/",
        prefix: "data/runs/a b/",
        folder: "a b",
      },
      {
        id: "runs_a_b_2",
        name: "runs/a_b",
        description: "gs://b/data/runs/a_b/",
        prefix: "data/runs/a_b/",
        folder: "a_b",
      },
      {
        id: "x_y",
        name: "x.y",
        description: "gs://b/data/x.y/",
        prefix: "data/x.y/",
        folder: "x.y",
      },
    ]);
  });

  it("makes the whole location one datasource", () => {
    expect(wholeLocation({ bucket: "my-bucket", prefix: "" })).toMatchObject({
      id: "my-bucket",
      name: "my-bucket",
      prefix: "",
      folder: "",
    });
    expect(wholeLocation({ bucket: "b", prefix: "runs/2024/" })).toMatchObject({
      id: "2024",
      name: "2024",
      description: "gs://b/runs/2024/",
    });
  });

  it("keeps names unique", () => {
    expect(uniqueNames(["a", "a", "a_2", "b"])).toEqual([
      "a",
      "a_2",
      "a_2_2",
      "b",
    ]);
  });
});

describe("Catalog", () => {
  const a: Datasource = {
    id: "a",
    name: "a",
    description: "",
    prefix: "a/",
    folder: "a",
  };
  const b = { ...a, id: "b", name: "b", prefix: "b/", folder: "b" };

  it("lists again once the list is stale", async () => {
    let now = 0;
    const load = vi.fn(async () => [a]);
    const catalog = new Catalog(load, 1000, () => now);
    await catalog.list();
    await catalog.list();
    expect(load).toHaveBeenCalledTimes(1);
    now = 1001;
    await catalog.list();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one listing between concurrent callers", async () => {
    const load = vi.fn(async () => [a]);
    const catalog = new Catalog(load, 1000);
    await Promise.all([catalog.list(), catalog.list(), catalog.get("a")]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("looks up known IDs without listing, and unknown ones once stale", async () => {
    let now = 0;
    const load = vi.fn(async () => (load.mock.calls.length > 1 ? [a, b] : [a]));
    const catalog = new Catalog(load, 1000, () => now);
    await catalog.list();
    now = 5000;
    expect(await catalog.get("a")).toBe(a);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await catalog.get("b")).toEqual(b);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous list when listing again fails", async () => {
    let now = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const load = vi
      .fn<() => Promise<Datasource[]>>()
      .mockResolvedValueOnce([a])
      .mockRejectedValueOnce(new Error("offline"));
    const catalog = new Catalog(load, 1000, () => now);
    await catalog.list();
    now = 2000;
    expect(await catalog.list()).toEqual([a]);
    expect(await catalog.list()).toEqual([a]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("fails when the first listing fails", async () => {
    const catalog = new Catalog(async () => {
      throw new Error("denied");
    }, 1000);
    await expect(catalog.list()).rejects.toThrow("denied");
  });
});
