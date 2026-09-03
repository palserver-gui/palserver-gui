import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getWorkshopModsStatus, setWorkshopGlobalEnabled, setWorkshopModEnabled } from "./workshop-mods.js";
import type { InstanceRecord } from "./store.js";

let tmp = "";
// runtime=wine → serverPlatform 回 windows,不依賴測試機 OS。
const rec = () => ({ id: "t", backend: "native", runtime: "wine", serverDir: tmp }) as unknown as InstanceRecord;
const ctx = () => ({ instanceDir: path.join(tmp, "inst") });

function addMod(folder: string, info: Record<string, unknown>) {
  const d = path.join(tmp, "Mods", "Workshop", folder);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "Info.json"), JSON.stringify(info));
}
const iniPath = () => path.join(tmp, "Mods", "PalModSettings.ini");

describe("workshop mods fs layer", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
    fs.mkdirSync(path.join(tmp, "Pal"), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("unsupported on docker; native without wine follows the host OS", () => {
    assert.equal(getWorkshopModsStatus({ ...rec(), backend: "docker" } as InstanceRecord, ctx()).supported, false);
    const plain = { ...rec(), runtime: undefined } as unknown as InstanceRecord;
    assert.equal(getWorkshopModsStatus(plain, ctx()).supported, process.platform === "win32");
  });

  it("lists mods, creates Workshop dir, reports missing ini", () => {
    addMod("3001", { PackageName: "Alpha", ModName: "Alpha Mod", Version: "1.0", InstallRule: [{ IsServer: true }] });
    addMod("3002", { PackageName: "Beta", InstallRule: [{ Type: "Paks" }] });
    fs.mkdirSync(path.join(tmp, "Mods", "Workshop", "junk"));
    const s = getWorkshopModsStatus(rec(), ctx());
    assert.equal(s.supported, true);
    assert.equal(s.workshopDir, "Mods/Workshop");
    assert.equal(s.iniExists, false);
    assert.equal(s.globalEnabled, true);
    assert.deepEqual(s.mods.map((m) => [m.packageName, m.isServer, m.enabled]), [["Alpha", true, false], ["Beta", false, false]]);
    assert.equal(fs.existsSync(path.join(tmp, "Mods", "Workshop")), true);
  });

  it("toggle writes ActiveModList, creates ini when missing, and round-trips", () => {
    addMod("3001", { PackageName: "Alpha", InstallRule: [{ IsServer: true }] });
    let s = setWorkshopModEnabled(rec(), ctx(), "Alpha", true);
    assert.equal(s.iniExists, true);
    assert.equal(s.mods[0].enabled, true);
    assert.equal(fs.readFileSync(iniPath(), "utf8"), "[PalModSettings]\nActiveModList=Alpha\n");
    s = setWorkshopGlobalEnabled(rec(), ctx(), false);
    assert.equal(s.globalEnabled, false);
    s = setWorkshopModEnabled(rec(), ctx(), "Alpha", false);
    assert.equal(s.mods[0].enabled, false);
    assert.equal(fs.readFileSync(iniPath(), "utf8"), "[PalModSettings]\nbGlobalEnableMod=false\n");
  });

  it("orphan entries are reported and can be disabled; enabling unknown mod throws 404", () => {
    fs.mkdirSync(path.join(tmp, "Mods"), { recursive: true });
    fs.writeFileSync(iniPath(), "[PalModSettings]\r\nbGlobalEnableMod=true\r\nActiveModList=Gone\r\n");
    assert.deepEqual(getWorkshopModsStatus(rec(), ctx()).orphanActive, ["Gone"]);
    assert.throws(() => setWorkshopModEnabled(rec(), ctx(), "Gone", true), /unknown workshop mod/);
    assert.deepEqual(setWorkshopModEnabled(rec(), ctx(), "Gone", false).orphanActive, []);
    assert.equal(fs.readFileSync(iniPath(), "utf8"), "[PalModSettings]\r\nbGlobalEnableMod=true\r\n");
  });

  it("prefers Pal/Binaries/Win64/Mods when the server already generated the ini there", () => {
    const alt = path.join(tmp, "Pal", "Binaries", "Win64", "Mods");
    fs.mkdirSync(alt, { recursive: true });
    fs.writeFileSync(path.join(alt, "PalModSettings.ini"), "[PalModSettings]\nbGlobalEnableMod=true\n");
    assert.equal(getWorkshopModsStatus(rec(), ctx()).workshopDir, "Pal/Binaries/Win64/Mods/Workshop");
  });
});
