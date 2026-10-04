import { describe, expect, it } from "vitest";
import { UsageError } from "./datasources.ts";
import { DEFAULT_PORT, parseCommand, parseOriginAnswer } from "./options.ts";

describe("parseCommand", () => {
  it("serves the whole bucket by default", () => {
    expect(parseCommand(["gs://my-bucket"])).toEqual({
      kind: "serve",
      options: {
        location: { bucket: "my-bucket", prefix: "" },
        port: DEFAULT_PORT,
        origins: [],
      },
    });
  });

  it("takes a glob, port and origins", () => {
    const command = parseCommand([
      "my-bucket",
      "runs/*",
      "-p",
      "4000",
      "--origin",
      "https://cnxt.example.org/",
      "-o",
      "http://localhost:5173",
    ]);
    expect(command).toEqual({
      kind: "serve",
      options: {
        location: { bucket: "my-bucket", prefix: "" },
        glob: "runs/*",
        segments: ["runs", "*"],
        port: 4000,
        origins: ["https://cnxt.example.org", "http://localhost:5173"],
      },
    });
  });

  it("accepts '*' for any origin", () => {
    const command = parseCommand(["my-bucket", "--origin", "*"]);
    expect(command.kind === "serve" && command.options.origins).toEqual(["*"]);
  });

  it("handles help and version", () => {
    expect(parseCommand(["--help"])).toEqual({ kind: "help" });
    expect(parseCommand(["-v"])).toEqual({ kind: "version" });
  });

  it("rejects bad input with a usage error", () => {
    for (const argv of [
      [],
      ["b", "a", "b"],
      ["my-bucket", "--port", "0"],
      ["my-bucket", "--port", "x"],
      ["my-bucket", "--origin", "cnxt.example.org"],
      ["my-bucket", "--origin", "ftp://cnxt.example.org"],
      ["my-bucket", "--bogus"],
    ]) {
      expect(() => parseCommand(argv), argv.join(" ")).toThrow(UsageError);
    }
  });

  it("hints at shell expansion when given too many arguments", () => {
    expect(() => parseCommand(["b", "file1", "file2"])).toThrow(
      /Quote the glob/
    );
  });
});

describe("parseOriginAnswer", () => {
  it("takes one or more origins", () => {
    expect(
      parseOriginAnswer(" https://cnxt.example.org/,http://localhost:5173 ")
    ).toEqual(["https://cnxt.example.org", "http://localhost:5173"]);
    expect(parseOriginAnswer("*")).toEqual(["*"]);
  });

  it("allows any origin when left empty", () => {
    expect(parseOriginAnswer("")).toEqual(["*"]);
    expect(parseOriginAnswer("  ")).toEqual(["*"]);
  });

  it("rejects what isn't an origin", () => {
    expect(() => parseOriginAnswer("cnxt.example.org")).toThrow(UsageError);
  });
});
