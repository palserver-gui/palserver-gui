import { describe, expect, it } from "vitest";
import { buildLaunchArgs, splitExtraArgs } from "./launch-options";

describe("buildLaunchArgs", () => {
  it("defaults: only -publiclobby", () => {
    expect(buildLaunchArgs(undefined)).toEqual(["-publiclobby"]);
  });
  it("enableGamedataApi → -enable-gamedata-api", () => {
    expect(buildLaunchArgs({ enableGamedataApi: true })).toEqual(["-publiclobby", "-enable-gamedata-api"]);
  });
  it("extraArgs appended verbatim as separate tokens", () => {
    expect(buildLaunchArgs({ publiclobby: false, extraArgs: "  -foo   -bar=1\n-baz " })).toEqual(["-foo", "-bar=1", "-baz"]);
  });
  it("empty extraArgs adds nothing", () => {
    expect(buildLaunchArgs({ extraArgs: "" })).toEqual(["-publiclobby"]);
  });
});

describe("splitExtraArgs", () => {
  it("splits on any whitespace and drops empties", () => {
    expect(splitExtraArgs(" a\tb  c ")).toEqual(["a", "b", "c"]);
    expect(splitExtraArgs("")).toEqual([]);
  });
});
