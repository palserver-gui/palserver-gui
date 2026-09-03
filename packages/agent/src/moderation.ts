import path from "node:path";
import type { BanEntry, BanOutcome, BanSource, ModerationLists, WhitelistEntry } from "@palserver/shared";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { serverPlatform } from "./platform.js";
import { getPdDir } from "./paldefender-rest.js";
import { serverRoot } from "./native.js";
import * as dockerOps from "./docker.js";
import { execInPod } from "./k8s-files.js";
import { rconExec } from "./rcon.js";
import { rest } from "./restapi.js";

/**
 * 封鎖名單有兩套,彼此獨立、連線時各自檢查:
 *
 * 1. 遊戲本體:`Pal/Saved/SaveGames/banlist.txt`,一行一個 userId。官方 REST
 *    `/ban`、RCON `BanPlayer` 寫這裡。沒裝 PalDefender 的伺服器只有這一套。
 * 2. PalDefender:`<PD 目錄>/Banlist.json`,由 PalDefender 的 RCON `ban` 寫入。
 *    白名單(WhiteList.json / Config.json useWhitelist)也只有 PalDefender 有。
 *
 * 之前 GUI 的「封鎖」按鈕只寫第 1 套、名單卡只讀第 2 套,兩邊對不上;而且
 * PalDefender 回「找不到玩家」之類的失敗文字時也照樣顯示成功。現在:
 * - 讀:兩套都讀、合併顯示並標來源。
 * - 寫:`banEverywhere` / `unbanEverywhere` 兩套都寫(裝了 PalDefender 才寫第 2 套),
 *   而且 read-back banlist.txt 確認真的落地。
 * - RCON 回應會被檢查,PalDefender 拒絕就回錯誤,不再靜默。
 *
 * 讀檔一律走 runtime(docker/k8s 用 exec),伺服器離線時名單也看得到。
 * PalDefender 的名單依它的文件不手改,異動一律走 RCON。
 */

const looksLikeIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}(\/\d+)?$/.test(s.trim());

async function readTextInRuntime(rec: InstanceRecord, file: string): Promise<string | null> {
  if (rec.backend === "native") {
    const fs = await import("node:fs");
    try { return fs.readFileSync(file, "utf8"); } catch { return null; }
  }
  if (rec.backend === "docker") {
    try { return await dockerOps.execInContainer(rec, ["cat", file]); } catch { return null; }
  }
  try { return await execInPod(rec, ["cat", file]); } catch { return null; }
}

async function readJsonInRuntime<T>(rec: InstanceRecord, file: string): Promise<T | null> {
  const raw = await readTextInRuntime(rec, file);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/** 遊戲本體封鎖名單的路徑(native = host fs;docker/k8s = 容器內 /palworld)。 */
export function vanillaBanlistPath(rec: InstanceRecord, ctx: DriverContext): string {
  if (rec.backend === "native") {
    return path.join(serverRoot(rec, ctx), "Pal", "Saved", "SaveGames", "banlist.txt");
  }
  return "/palworld/Pal/Saved/SaveGames/banlist.txt";
}

/** banlist.txt:一行一個 userId(`steam_…`、跨平台前綴、或 IP),`#` 開頭是註解。 */
export function parseVanillaBanlist(raw: string): BanEntry[] {
  const seen = new Set<string>();
  const out: BanEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#") || seen.has(value)) continue;
    seen.add(value);
    out.push(
      looksLikeIp(value)
        ? { userId: null, ip: value, source: "vanilla" }
        : { userId: value, ip: null, source: "vanilla" },
    );
  }
  return out;
}

/** 讀 banlist.txt;null = 讀不到(沒生成過、路徑不對、容器沒在跑)。 */
export async function readVanillaBans(rec: InstanceRecord, ctx: DriverContext): Promise<BanEntry[] | null> {
  const raw = await readTextInRuntime(rec, vanillaBanlistPath(rec, ctx));
  return raw === null ? null : parseVanillaBanlist(raw);
}

/** WhiteList.json is an array of strings (UserIds and/or IPs). */
function parseWhitelist(raw: unknown): WhitelistEntry[] {
  const values: string[] = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : Array.isArray((raw as { whitelist?: string[] })?.whitelist)
      ? (raw as { whitelist: string[] }).whitelist
      : [];
  return values.map((value) => ({ value, isIp: looksLikeIp(value) }));
}

/** Banlist.json shape varies by version; accept the common forms. */
export function parseBanlist(raw: unknown): BanEntry[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { bans?: unknown[] })?.bans)
      ? (raw as { bans: unknown[] }).bans
      : raw && typeof raw === "object"
        ? Object.entries(raw as Record<string, unknown>).map(([k, v]) => ({ userId: k, ...(v as object) }))
        : [];
  return list.map((item): BanEntry => {
    if (typeof item === "string") {
      return looksLikeIp(item)
        ? { userId: null, ip: item, source: "paldefender" }
        : { userId: item, ip: null, source: "paldefender" };
    }
    const o = (item ?? {}) as Record<string, unknown>;
    const userId = (o.userId ?? o.UserId ?? o.userid ?? o.steamId ?? null) as string | null;
    const ip = (o.ip ?? o.IP ?? o.Ip ?? null) as string | null;
    const reason = (o.reason ?? o.Reason ?? undefined) as string | undefined;
    return { userId: userId || null, ip: ip || null, reason, source: "paldefender" };
  });
}

/** 兩套名單合併:同一個 userId/IP 兩邊都有就標 both,原因以 PalDefender 的為準。 */
export function mergeBans(paldefender: BanEntry[], vanilla: BanEntry[]): BanEntry[] {
  const keyOf = (b: BanEntry) => (b.userId ? `id:${b.userId}` : `ip:${b.ip}`);
  const byKey = new Map<string, BanEntry>();
  for (const b of paldefender) byKey.set(keyOf(b), { ...b, source: "paldefender" });
  for (const b of vanilla) {
    const k = keyOf(b);
    const prev = byKey.get(k);
    if (prev) byKey.set(k, { ...prev, source: "both" });
    else byKey.set(k, { ...b, source: "vanilla" });
  }
  return [...byKey.values()];
}

export async function getModerationLists(rec: InstanceRecord, ctx: DriverContext): Promise<ModerationLists> {
  const vanilla = (await readVanillaBans(rec, ctx)) ?? [];
  if (serverPlatform(rec) !== "windows") {
    return { supported: false, reason: "名單管理僅支援 Windows 伺服器", whitelistEnabled: false, whitelist: [], bans: vanilla };
  }
  const dir = await getPdDir(rec, ctx);
  if (!dir) {
    return {
      supported: false,
      reason: "尚未安裝 PalDefender,或伺服器尚未啟動過以生成設定檔",
      whitelistEnabled: false,
      whitelist: [],
      bans: vanilla,
    };
  }
  const [wlRaw, blRaw, cfgRaw] = await Promise.all([
    readJsonInRuntime<unknown>(rec, `${dir}/WhiteList.json`),
    readJsonInRuntime<unknown>(rec, `${dir}/Banlist.json`),
    readJsonInRuntime<{ useWhitelist?: boolean }>(rec, `${dir}/Config.json`),
  ]);
  return {
    supported: true,
    whitelistEnabled: cfgRaw?.useWhitelist === true,
    whitelist: parseWhitelist(wlRaw),
    bans: mergeBans(parseBanlist(blRaw), vanilla),
  };
}

// ── PalDefender RCON 指令 ──────────────────────────────────────────────

/** PalDefender 的失敗是回應文字,不是協定錯誤 —— 不檢查就會把「找不到玩家」顯示成「已封鎖」。
 * 沒有官方的錯誤字串清單(2026-09-03 查過文件沒列),這裡抓常見的失敗詞。 */
const RCON_REJECTED = /unknown command|not found|invalid|usage:|\berror\b|failed|no such|not a valid|does not exist/i;

export function assertRconAccepted(command: string, response: string): string {
  if (RCON_REJECTED.test(response)) {
    throw Object.assign(new Error(`PalDefender 沒有接受指令「${command}」:${response}`), { statusCode: 502 });
  }
  return response;
}

async function pdCommand(rec: InstanceRecord, command: string): Promise<string> {
  const response = await rconExec(rec, command);
  return assertRconAccepted(command.split(" ")[0]!, response);
}

/** RCON-backed mutations. PalDefender reloads its lists as it runs these. */
export const moderation = {
  whitelistAdd: (rec: InstanceRecord, userId: string) => pdCommand(rec, `whitelist_add ${userId}`),
  whitelistRemove: (rec: InstanceRecord, userId: string) => pdCommand(rec, `whitelist_remove ${userId}`),
  ban: (rec: InstanceRecord, userId: string, reason?: string) =>
    pdCommand(rec, `ban ${userId}${reason ? ` ${reason}` : ""}`),
  unban: (rec: InstanceRecord, userId: string) => pdCommand(rec, `unban ${userId}`),
  banIp: (rec: InstanceRecord, ip: string) => pdCommand(rec, `banip ${ip}`),
  unbanIp: (rec: InstanceRecord, ip: string) => pdCommand(rec, `unbanip ${ip}`),
};

// ── 兩套一起寫 ────────────────────────────────────────────────────────

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface BanBackends {
  /** 官方 REST /ban、/unban */
  vanillaBan: (rec: InstanceRecord, userId: string, message?: string) => Promise<unknown>;
  vanillaUnban: (rec: InstanceRecord, userId: string) => Promise<unknown>;
  /** PalDefender RCON ban/unban;回應文字 */
  pdBan: (rec: InstanceRecord, userId: string, reason?: string) => Promise<string>;
  pdUnban: (rec: InstanceRecord, userId: string) => Promise<string>;
  /** banlist.txt 目前的內容;null = 讀不到 */
  readVanilla: (rec: InstanceRecord, ctx: DriverContext) => Promise<BanEntry[] | null>;
}

const defaultBackends: BanBackends = {
  vanillaBan: (rec, userId, message) => rest.ban(rec, userId, message),
  vanillaUnban: (rec, userId) => rest.unban(rec, userId),
  pdBan: (rec, userId, reason) => moderation.ban(rec, userId, reason),
  pdUnban: (rec, userId) => moderation.unban(rec, userId),
  readVanilla: readVanillaBans,
};

async function applyEverywhere(
  rec: InstanceRecord,
  ctx: DriverContext,
  userId: string,
  pdActive: boolean,
  run: {
    vanilla: () => Promise<unknown>;
    pd: () => Promise<string>;
    /** read-back 期望:ban → 名單裡要有;unban → 名單裡要沒有 */
    expectPresent: boolean;
    verb: string;
  },
  backends: BanBackends,
): Promise<BanOutcome> {
  const outcome: BanOutcome = { userId, vanilla: { ok: true }, paldefender: null, verified: null };
  try {
    await run.vanilla();
  } catch (e) {
    outcome.vanilla = { ok: false, error: errMsg(e) };
  }
  if (pdActive) {
    try {
      outcome.paldefender = { ok: true, response: await run.pd() };
    } catch (e) {
      outcome.paldefender = { ok: false, error: errMsg(e) };
    }
  }
  const pdFailed = outcome.paldefender !== null && !outcome.paldefender.ok;
  if (!outcome.vanilla.ok && (outcome.paldefender === null || pdFailed)) {
    // 兩條路都沒寫進去 —— 這才是真的失敗。
    const parts = [`官方 API:${outcome.vanilla.error}`];
    if (pdFailed) parts.push(`PalDefender:${(outcome.paldefender as { error: string }).error}`);
    throw Object.assign(new Error(`${run.verb}失敗 — ${parts.join(";")}`), { statusCode: 502 });
  }
  const list = await backends.readVanilla(rec, ctx);
  if (list !== null) {
    const present = list.some((b) => b.userId === userId || b.ip === userId);
    outcome.verified = present === run.expectPresent;
  }
  return outcome;
}

/** 封鎖:官方 REST /ban + (裝了 PalDefender 就再) RCON ban,然後 read-back banlist.txt。
 * 任一條寫成功就算成功(另一條的錯誤留在回傳裡讓 UI 提示);兩條都失敗才拋錯。 */
export function banEverywhere(
  rec: InstanceRecord,
  ctx: DriverContext,
  userId: string,
  opts: { pdActive: boolean; message?: string; backends?: BanBackends },
): Promise<BanOutcome> {
  const b = opts.backends ?? defaultBackends;
  return applyEverywhere(
    rec,
    ctx,
    userId,
    opts.pdActive,
    {
      vanilla: () => b.vanillaBan(rec, userId, opts.message),
      pd: () => b.pdBan(rec, userId, opts.message),
      expectPresent: true,
      verb: "封鎖",
    },
    b,
  );
}

export function unbanEverywhere(
  rec: InstanceRecord,
  ctx: DriverContext,
  userId: string,
  opts: { pdActive: boolean; backends?: BanBackends },
): Promise<BanOutcome> {
  const b = opts.backends ?? defaultBackends;
  return applyEverywhere(
    rec,
    ctx,
    userId,
    opts.pdActive,
    {
      vanilla: () => b.vanillaUnban(rec, userId),
      pd: () => b.pdUnban(rec, userId),
      expectPresent: false,
      verb: "解除封鎖",
    },
    b,
  );
}

export type { BanSource };
