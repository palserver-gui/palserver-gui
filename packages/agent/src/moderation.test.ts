import assert from "node:assert/strict";
import test from "node:test";
import type { BanEntry } from "@palserver/shared";
import {
  assertRconAccepted,
  banEverywhere,
  mergeBans,
  parseBanlist,
  parseVanillaBanlist,
  unbanEverywhere,
  type BanBackends,
} from "./moderation.js";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";

const rec = { id: "mod", backend: "native", settings: {} } as unknown as InstanceRecord;
const ctx: DriverContext = { instanceDir: "" };
const ID = "steam_76561198000000001";

test("banlist.txt: one id per line, comments and blanks skipped, IPs detected", () => {
  const bans = parseVanillaBanlist(`# banned\n${ID}\r\n\n10.0.0.5\n${ID}\n`);
  assert.deepEqual(bans, [
    { userId: ID, ip: null, source: "vanilla" },
    { userId: null, ip: "10.0.0.5", source: "vanilla" },
  ]);
});

test("merge marks ids present in both lists and keeps PalDefender's reason", () => {
  const pd = parseBanlist([{ userId: ID, reason: "griefing" }, "steam_2"]);
  const vanilla = parseVanillaBanlist(`${ID}\nsteam_3`);
  const merged = mergeBans(pd, vanilla);
  assert.deepEqual(
    merged.map((b) => [b.userId, b.source, b.reason]),
    [
      [ID, "both", "griefing"],
      ["steam_2", "paldefender", undefined],
      ["steam_3", "vanilla", undefined],
    ],
  );
});

test("PalDefender failure text is an error, not a silent success", () => {
  assert.throws(() => assertRconAccepted("ban", "Player not found"), /沒有接受指令「ban」/);
  assert.throws(() => assertRconAccepted("ban", "Unknown command: ban"));
  assert.equal(assertRconAccepted("ban", `Banned ${ID}`), `Banned ${ID}`);
  assert.equal(assertRconAccepted("unban", ""), "");
});

function fakeBackends(opts: {
  vanillaFails?: string;
  pdFails?: string;
  file?: BanEntry[] | null;
}): BanBackends & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    vanillaBan: async (_r, id) => {
      calls.push(`rest.ban ${id}`);
      if (opts.vanillaFails) throw new Error(opts.vanillaFails);
    },
    vanillaUnban: async (_r, id) => {
      calls.push(`rest.unban ${id}`);
      if (opts.vanillaFails) throw new Error(opts.vanillaFails);
    },
    pdBan: async (_r, id, reason) => {
      calls.push(`pd.ban ${id} ${reason ?? ""}`.trim());
      if (opts.pdFails) throw new Error(opts.pdFails);
      return "ok";
    },
    pdUnban: async (_r, id) => {
      calls.push(`pd.unban ${id}`);
      if (opts.pdFails) throw new Error(opts.pdFails);
      return "ok";
    },
    readVanilla: async () => opts.file === undefined ? [] : opts.file,
  };
}

test("ban writes both lists when PalDefender is active and verifies banlist.txt", async () => {
  const backends = fakeBackends({ file: [{ userId: ID, ip: null }] });
  const out = await banEverywhere(rec, ctx, ID, { pdActive: true, message: "bye", backends });
  assert.deepEqual(backends.calls, [`rest.ban ${ID}`, `pd.ban ${ID} bye`]);
  assert.deepEqual(out, { userId: ID, vanilla: { ok: true }, paldefender: { ok: true, response: "ok" }, verified: true });
});

test("ban skips PalDefender when it is not installed", async () => {
  const backends = fakeBackends({ file: [{ userId: ID, ip: null }] });
  const out = await banEverywhere(rec, ctx, ID, { pdActive: false, backends });
  assert.deepEqual(backends.calls, [`rest.ban ${ID}`]);
  assert.equal(out.paldefender, null);
  assert.equal(out.verified, true);
});

test("ban reports verified=false when banlist.txt is readable but lacks the id", async () => {
  const backends = fakeBackends({ file: [] });
  const out = await banEverywhere(rec, ctx, ID, { pdActive: false, backends });
  assert.equal(out.verified, false);
});

test("ban reports verified=null when banlist.txt cannot be read", async () => {
  const backends = fakeBackends({ file: null });
  const out = await banEverywhere(rec, ctx, ID, { pdActive: false, backends });
  assert.equal(out.verified, null);
});

test("ban survives one backend failing but fails when both fail", async () => {
  const oneDown = fakeBackends({ vanillaFails: "REST 未啟用", file: null });
  const out = await banEverywhere(rec, ctx, ID, { pdActive: true, backends: oneDown });
  assert.deepEqual(out.vanilla, { ok: false, error: "REST 未啟用" });
  assert.deepEqual(out.paldefender, { ok: true, response: "ok" });

  const bothDown = fakeBackends({ vanillaFails: "REST 未啟用", pdFails: "Player not found", file: null });
  await assert.rejects(
    banEverywhere(rec, ctx, ID, { pdActive: true, backends: bothDown }),
    (e: Error & { statusCode?: number }) =>
      e.statusCode === 502 && /官方 API:REST 未啟用/.test(e.message) && /PalDefender:Player not found/.test(e.message),
  );

  const onlyVanillaDown = fakeBackends({ vanillaFails: "REST 未啟用", file: null });
  await assert.rejects(banEverywhere(rec, ctx, ID, { pdActive: false, backends: onlyVanillaDown }), /封鎖失敗/);
});

test("unban removes from both lists and verifies the id is gone", async () => {
  const backends = fakeBackends({ file: [] });
  const out = await unbanEverywhere(rec, ctx, ID, { pdActive: true, backends });
  assert.deepEqual(backends.calls, [`rest.unban ${ID}`, `pd.unban ${ID}`]);
  assert.equal(out.verified, true);

  const stillThere = fakeBackends({ file: [{ userId: ID, ip: null }] });
  const out2 = await unbanEverywhere(rec, ctx, ID, { pdActive: false, backends: stillThere });
  assert.equal(out2.verified, false);
});
