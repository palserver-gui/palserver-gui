import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorldSaver, rconSaveSucceeded } from "./world-save.js";
import { BACKUP_TAR_EXCLUDES } from "./saves.js";
import type { InstanceRecord } from "./store.js";

const execFileP = promisify(execFile);

const recWith = (settings: Record<string, unknown>): InstanceRecord =>
  ({ id: "inst-1", settings }) as unknown as InstanceRecord;

test("saveWorld: RCON Save first when RCON is enabled; REST untouched", async () => {
  const calls: string[] = [];
  const save = createWorldSaver({
    rconSave: async () => (calls.push("rcon"), "Complete Save"),
    restSave: async () => void calls.push("rest"),
  });
  assert.deepEqual(await save(recWith({ RCONEnabled: true })), { via: "rcon" });
  assert.deepEqual(calls, ["rcon"]);
});

test("saveWorld: falls back to REST when RCON is off or fails", async () => {
  const offCalls: string[] = [];
  const saveOff = createWorldSaver({
    rconSave: async () => (offCalls.push("rcon"), "Complete Save"),
    restSave: async () => void offCalls.push("rest"),
  });
  assert.deepEqual(await saveOff(recWith({ RCONEnabled: false })), { via: "rest" });
  assert.deepEqual(offCalls, ["rest"]);

  const failCalls: string[] = [];
  const saveFail = createWorldSaver({
    rconSave: async () => {
      failCalls.push("rcon");
      throw new Error("RCON 指令逾時(60 秒內沒有回應)");
    },
    restSave: async () => void failCalls.push("rest"),
  });
  assert.deepEqual(await saveFail(recWith({ RCONEnabled: true })), { via: "rest" });
  assert.deepEqual(failCalls, ["rcon", "rest"]);
});

test("saveWorld: both paths failing reports both reasons", async () => {
  const save = createWorldSaver({
    rconSave: async () => "Unknown command: Save",
    restSave: async () => {
      throw new Error("REST API 逾時(60 秒內沒有回應)");
    },
  });
  await assert.rejects(save(recWith({ RCONEnabled: true })), (err: Error) => {
    assert.match(err.message, /RCON\/REST 存檔失敗或逾時/);
    assert.match(err.message, /RCON:Unknown command/);
    assert.match(err.message, /REST:REST API 逾時/);
    return true;
  });
});

test("saveWorld: concurrent callers for one instance share a single in-flight save", async () => {
  let rconCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const save = createWorldSaver({
    rconSave: async () => {
      rconCalls += 1;
      await gate;
      return "Complete Save";
    },
    restSave: async () => {},
  });
  const rec = recWith({ RCONEnabled: true });
  const a = save(rec);
  const b = save(rec);
  const c = save(recWith({ RCONEnabled: true })); // same id → same flight
  release();
  await Promise.all([a, b, c]);
  assert.equal(rconCalls, 1);
  // after settling, a new call is a new save
  await save(rec);
  assert.equal(rconCalls, 2);
});

test("rconSaveSucceeded recognises the server's replies", () => {
  assert.equal(rconSaveSucceeded("Complete Save"), true);
  assert.equal(rconSaveSucceeded(""), true);
  assert.equal(rconSaveSucceeded("Unknown command: Save"), false);
});

test("backup tar excludes the server's rolling backup/ and *.bak but keeps the live world", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "palserver-backup-"));
  const world = path.join(dir, "world");
  for (const d of ["Players", "backup/world/2026.01.01-00.00.00", "backup/local", "world_save_bak"]) {
    fs.mkdirSync(path.join(world, d), { recursive: true });
  }
  fs.writeFileSync(path.join(world, "Level.sav"), "level");
  fs.writeFileSync(path.join(world, "LevelMeta.sav"), "meta");
  fs.writeFileSync(path.join(world, "Level.sav.bak"), "old");
  fs.writeFileSync(path.join(world, "Players", "0000000000000000000000000000ABCD.sav"), "p");
  fs.writeFileSync(path.join(world, "backup/world/2026.01.01-00.00.00", "Level.sav"), "rolling");
  fs.writeFileSync(path.join(world, "backup/local", "Level.sav"), "rolling");
  fs.writeFileSync(path.join(world, "world_save_bak", "Level.sav"), "bak");
  const archive = path.join(dir, "out.tar.gz");
  await execFileP("tar", ["-czf", archive, "-C", world, ...BACKUP_TAR_EXCLUDES.map((e) => `--exclude=${e}`), "."]);
  const listing = (await execFileP("tar", ["-tzf", archive])).stdout
    .split(/\r?\n/)
    .map((l) => l.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((l) => l && l !== ".");
  assert.deepEqual(
    listing.sort(),
    ["Level.sav", "LevelMeta.sav", "Players", "Players/0000000000000000000000000000ABCD.sav"].sort(),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
