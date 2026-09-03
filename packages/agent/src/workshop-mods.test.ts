import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInfoJson, parsePalModSettings, updatePalModSettings } from "./workshop-mods.js";

describe("parseInfoJson", () => {
  it("reads PackageName/ModName/Version/Author and IsServer from InstallRule", () => {
    const info = parseInfoJson(JSON.stringify({
      ModName: "Gaming Cattiva", PackageName: "GamingCattiva", Version: "1.2.0", Author: "me",
      InstallRule: [{ Type: "Paks", Targets: ["./Paks/"] }, { Type: "Lua", Targets: ["./Lua/"], IsServer: true }],
    }));
    assert.deepEqual(info, { packageName: "GamingCattiva", name: "Gaming Cattiva", version: "1.2.0", author: "me", isServer: true });
  });
  it("isServer=false when no rule has IsServer:true; name falls back to PackageName", () => {
    const info = parseInfoJson(JSON.stringify({ PackageName: "ClientOnly", InstallRule: [{ Type: "Paks" }] }));
    assert.deepEqual(info, { packageName: "ClientOnly", name: "ClientOnly", version: null, author: null, isServer: false });
  });
  it("rejects missing/invalid PackageName and broken JSON", () => {
    assert.equal(parseInfoJson("{"), null);
    assert.equal(parseInfoJson(JSON.stringify({ ModName: "x" })), null);
    assert.equal(parseInfoJson(JSON.stringify({ PackageName: "has space" })), null);
  });
});

describe("parsePalModSettings", () => {
  it("parses official format (CRLF, duplicates collapsed)", () => {
    const r = parsePalModSettings("[PalModSettings]\r\nbGlobalEnableMod=true\r\nActiveModList=A\r\nActiveModList=B\r\nActiveModList=A\r\n");
    assert.deepEqual(r, { globalEnabled: true, active: ["A", "B"] });
  });
  it("defaults to globalEnabled=true on empty file; reads False", () => {
    assert.deepEqual(parsePalModSettings(""), { globalEnabled: true, active: [] });
    assert.equal(parsePalModSettings("[PalModSettings]\nbGlobalEnableMod=False\n").globalEnabled, false);
  });
});

describe("updatePalModSettings", () => {
  const base = "[PalModSettings]\nbGlobalEnableMod=true\nActiveModList=A\n";
  it("creates section + global flag + entry from empty text", () => {
    assert.equal(
      updatePalModSettings("", { globalEnabled: true, mod: { packageName: "X", enabled: true } }),
      "[PalModSettings]\nbGlobalEnableMod=true\nActiveModList=X\n",
    );
  });
  it("appends after the last ActiveModList and is idempotent", () => {
    const once = updatePalModSettings(base, { mod: { packageName: "B", enabled: true } });
    assert.equal(once, "[PalModSettings]\nbGlobalEnableMod=true\nActiveModList=A\nActiveModList=B\n");
    assert.equal(updatePalModSettings(once, { mod: { packageName: "B", enabled: true } }), once);
  });
  it("disabling removes every matching line and keeps unrelated lines", () => {
    const text = "; comment\n[PalModSettings]\nbGlobalEnableMod=true\nActiveModList=A\nSomethingElse=1\nActiveModList=A\n";
    assert.equal(
      updatePalModSettings(text, { mod: { packageName: "A", enabled: false } }),
      "; comment\n[PalModSettings]\nbGlobalEnableMod=true\nSomethingElse=1\n",
    );
  });
  it("flips global flag in place and preserves CRLF", () => {
    const crlf = "[PalModSettings]\r\nbGlobalEnableMod=true\r\nActiveModList=A\r\n";
    assert.equal(updatePalModSettings(crlf, { globalEnabled: false }), "[PalModSettings]\r\nbGlobalEnableMod=false\r\nActiveModList=A\r\n");
  });
  it("does not match a package that is a prefix of another", () => {
    const text = "[PalModSettings]\nActiveModList=Foo\nActiveModList=FooBar\n";
    assert.equal(updatePalModSettings(text, { mod: { packageName: "Foo", enabled: false } }), "[PalModSettings]\nActiveModList=FooBar\n");
  });
});
