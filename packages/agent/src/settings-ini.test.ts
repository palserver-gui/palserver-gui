import { test } from "node:test";
import assert from "node:assert/strict";
import { diffIniAgainstSnapshot, diffIniTextAgainstSnapshot } from "./settings-ini.js";

const ini = (opts: string) => `[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(${opts})\n`;
const json = (v: unknown) => JSON.stringify(v);

// Palworld writes the settings it loaded at boot back to PalWorldSettings.ini when it
// shuts down. A GUI edit made while the server runs therefore comes back as the old
// value after a restart and must not be mistaken for a manual ini edit.
test("diffIniTextAgainstSnapshot: shutdown write-back of boot-time values is not a manual edit", () => {
  const booted = json({ ExpRate: 1, ServerDescription: "old" });
  const applied = json({ ExpRate: 3, ServerDescription: "new" });
  const afterShutdown = ini('ExpRate=1.000000,ServerDescription="old"');
  assert.deepEqual(diffIniTextAgainstSnapshot(afterShutdown, applied, booted), {});
});

test("diffIniTextAgainstSnapshot: a value differing from both snapshots is still a manual edit", () => {
  const booted = json({ ExpRate: 1 });
  const applied = json({ ExpRate: 3 });
  assert.deepEqual(diffIniTextAgainstSnapshot(ini("ExpRate=5.000000"), applied, booted), { ExpRate: 5 });
});

test("diffIniTextAgainstSnapshot: manual edit while stopped (boot == applied) is detected", () => {
  const snap = json({ ExpRate: 2 });
  assert.deepEqual(diffIniTextAgainstSnapshot(ini("ExpRate=4.000000"), snap, snap), { ExpRate: 4 });
});

test("diffIniTextAgainstSnapshot: without a boot snapshot the old behaviour is kept", () => {
  const applied = json({ ExpRate: 3 });
  assert.deepEqual(diffIniTextAgainstSnapshot(ini("ExpRate=1.000000"), applied), { ExpRate: 1 });
  assert.deepEqual(diffIniTextAgainstSnapshot(ini("ExpRate=1.000000"), applied, null), { ExpRate: 1 });
  assert.deepEqual(diffIniTextAgainstSnapshot(ini("ExpRate=1.000000"), applied, "not json"), { ExpRate: 1 });
});

test("diffIniAgainstSnapshot: reads the boot snapshot when present, tolerates it missing", () => {
  const files: Record<string, string> = {
    "/c/PalWorldSettings.ini": ini("ExpRate=1.000000"),
    "/i/world-applied.json": json({ ExpRate: 3 }),
    "/i/world-booted.json": json({ ExpRate: 1 }),
  };
  const read = (p: string) => {
    if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return files[p];
  };
  assert.deepEqual(diffIniAgainstSnapshot(read, "/c/PalWorldSettings.ini", "/i/world-applied.json", "/i/world-booted.json"), {});
  assert.deepEqual(diffIniAgainstSnapshot(read, "/c/PalWorldSettings.ini", "/i/world-applied.json", "/i/missing.json"), { ExpRate: 1 });
  assert.deepEqual(diffIniAgainstSnapshot(read, "/c/PalWorldSettings.ini", "/i/world-applied.json"), { ExpRate: 1 });
});
