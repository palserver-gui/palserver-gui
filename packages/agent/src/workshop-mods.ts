/**
 * Steam Workshop 模組(官方 1.0 模組系統):掃 Mods/Workshop 的 Info.json、讀寫 Mods/PalModSettings.ini。
 *
 * 官方文件(docs.palworldgame.com/settings-and-operation/mod/,2026-09-03):
 * - 只支援 Windows 專用伺服器 → 這裡只做 native + windows(docker/k8s 的 wine runtime 之後再說)。
 * - 目錄:`Mods/Workshop/<任意資料夾>/Info.json`,「與伺服器執行檔同層」。專案是直接啟動
 *   Pal/Binaries/Win64 底下的 shipping 執行檔,官方說的「同層」到底是安裝根目錄還是 Win64,
 *   文件沒講死 → resolveModsDir 兩個候選都看,哪邊已經有 PalModSettings.ini / Workshop 就用哪邊,
 *   都沒有就用安裝根目錄(官方範例 `.\Mods\Workshop\` 的寫法)。
 * - PalModSettings.ini 伺服器首次啟動後自動生成;不存在時我們自己建一份最小版本。
 * - 只動 ActiveModList / bGlobalEnableMod 兩種行,其餘行原樣保留(含伺服器之後可能加的鍵)。
 */
import fs from "node:fs";
import path from "node:path";
import type { WorkshopMod, WorkshopModsStatus } from "@palserver/shared";
import type { InstanceRecord } from "./store.js";
import type { DriverContext } from "./driver.js";
import { serverRoot } from "./native.js";
import { serverPlatform } from "./platform.js";

export const PACKAGE_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** 兩個候選的 Mods 目錄(相對於伺服器根目錄),見檔頭。 */
const MODS_DIR_CANDIDATES = ["Mods", path.join("Pal", "Binaries", "Win64", "Mods")];

export function resolveModsDir(root: string): string {
  for (const rel of MODS_DIR_CANDIDATES) {
    const abs = path.join(root, rel);
    if (fs.existsSync(path.join(abs, "PalModSettings.ini")) || fs.existsSync(path.join(abs, "Workshop"))) return rel;
  }
  return MODS_DIR_CANDIDATES[0];
}

// ── 純函式(可測) ──

export interface InfoJsonSummary {
  packageName: string;
  name: string;
  version: string | null;
  author: string | null;
  isServer: boolean;
}

/** 解析 Workshop 模組的 Info.json;缺 PackageName 或格式壞掉回 null。 */
export function parseInfoJson(text: string): InfoJsonSummary | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const packageName = typeof o.PackageName === "string" ? o.PackageName.trim() : "";
  if (!packageName || !PACKAGE_NAME_RE.test(packageName)) return null;
  const rules = Array.isArray(o.InstallRule) ? o.InstallRule : Array.isArray(o.InstallRules) ? o.InstallRules : [];
  const isServer = rules.some((r) => r && typeof r === "object" && (r as Record<string, unknown>).IsServer === true);
  return {
    packageName,
    name: typeof o.ModName === "string" && o.ModName.trim() ? o.ModName.trim() : packageName,
    version: typeof o.Version === "string" ? o.Version : typeof o.Version === "number" ? String(o.Version) : null,
    author: typeof o.Author === "string" && o.Author.trim() ? o.Author.trim() : null,
    isServer,
  };
}

const SECTION = "[PalModSettings]";
const GLOBAL_KEY = "bGlobalEnableMod";
const ACTIVE_KEY = "ActiveModList";

function parseBool(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1";
}

/** 讀 PalModSettings.ini:總開關(缺省 true,與官方生成檔一致)與 ActiveModList 清單(去重、保序)。 */
export function parsePalModSettings(text: string): { globalEnabled: boolean; active: string[] } {
  let globalEnabled = true;
  const active: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq <= 0 || line.startsWith(";") || line.startsWith("#")) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key === GLOBAL_KEY) globalEnabled = parseBool(val);
    else if (key === ACTIVE_KEY && val && !active.includes(val)) active.push(val);
  }
  return { globalEnabled, active };
}

export interface PalModSettingsPatch {
  globalEnabled?: boolean;
  /** 設定單一 PackageName 的啟用狀態。 */
  mod?: { packageName: string; enabled: boolean };
}

/** 改寫 PalModSettings.ini 內容:保留無關行與換行風格;沒有 section 就補;
 *  停用=移除該 PackageName 的所有 ActiveModList 行;啟用=不存在才加(接在最後一行 ActiveModList 之後,
 *  沒有就接在 bGlobalEnableMod 之後,再沒有就 section 標頭之後)。 */
export function updatePalModSettings(text: string, patch: PalModSettingsPatch): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let lines = text.length ? text.split(/\r?\n/) : [];
  // 去掉尾端空行,最後統一補一個換行。
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();

  let sectionIdx = lines.findIndex((l) => l.trim().toLowerCase() === SECTION.toLowerCase());
  if (sectionIdx < 0) {
    if (lines.length) lines.push("");
    lines.push(SECTION);
    sectionIdx = lines.length - 1;
  }
  const keyOf = (l: string) => {
    const t = l.trim();
    const eq = t.indexOf("=");
    return eq > 0 ? t.slice(0, eq).trim() : "";
  };
  const valOf = (l: string) => {
    const t = l.trim();
    const eq = t.indexOf("=");
    return eq > 0 ? t.slice(eq + 1).trim() : "";
  };

  if (patch.globalEnabled !== undefined) {
    const flag = `${GLOBAL_KEY}=${patch.globalEnabled ? "true" : "false"}`;
    const idx = lines.findIndex((l) => keyOf(l) === GLOBAL_KEY);
    if (idx >= 0) lines[idx] = flag;
    else lines.splice(sectionIdx + 1, 0, flag);
  }

  if (patch.mod) {
    const { packageName, enabled } = patch.mod;
    if (!enabled) {
      lines = lines.filter((l) => !(keyOf(l) === ACTIVE_KEY && valOf(l) === packageName));
    } else if (!lines.some((l) => keyOf(l) === ACTIVE_KEY && valOf(l) === packageName)) {
      const entry = `${ACTIVE_KEY}=${packageName}`;
      let at = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (keyOf(lines[i]) === ACTIVE_KEY) { at = i; break; }
      }
      if (at < 0) at = lines.findIndex((l) => keyOf(l) === GLOBAL_KEY);
      if (at < 0) at = lines.findIndex((l) => l.trim().toLowerCase() === SECTION.toLowerCase());
      lines.splice(at + 1, 0, entry);
    }
  }
  return lines.join(eol) + eol;
}

// ── 檔案系統層 ──

function unsupported(reason: string): WorkshopModsStatus {
  return { supported: false, reason, workshopDir: null, iniExists: false, globalEnabled: true, mods: [], orphanActive: [] };
}

function paths(rec: InstanceRecord, ctx: DriverContext) {
  const root = serverRoot(rec, ctx);
  const modsRel = resolveModsDir(root);
  const modsDir = path.join(root, modsRel);
  return {
    root,
    modsDir,
    workshopRel: path.posix.join(modsRel.split(path.sep).join("/"), "Workshop"),
    workshopDir: path.join(modsDir, "Workshop"),
    iniPath: path.join(modsDir, "PalModSettings.ini"),
  };
}

export function getWorkshopModsStatus(rec: InstanceRecord, ctx: DriverContext): WorkshopModsStatus {
  if (rec.backend !== "native" || serverPlatform(rec) !== "windows") {
    return unsupported("官方 Steam Workshop 模組系統只支援 Windows 專用伺服器(本機 native 後端)");
  }
  const p = paths(rec, ctx);
  if (!fs.existsSync(path.join(p.root, "Pal"))) {
    return unsupported("伺服器尚未安裝完成 — 先啟動一次讓 agent 下載伺服器");
  }
  // 讓「開啟 Workshop 資料夾」按鈕有地方可開;建目錄無副作用。
  fs.mkdirSync(p.workshopDir, { recursive: true });

  const iniExists = fs.existsSync(p.iniPath);
  const { globalEnabled, active } = parsePalModSettings(iniExists ? fs.readFileSync(p.iniPath, "utf8") : "");

  const mods: WorkshopMod[] = [];
  for (const entry of fs.readdirSync(p.workshopDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const infoPath = path.join(p.workshopDir, entry.name, "Info.json");
    if (!fs.existsSync(infoPath)) continue;
    let info: InfoJsonSummary | null = null;
    try {
      info = parseInfoJson(fs.readFileSync(infoPath, "utf8"));
    } catch {
      info = null;
    }
    if (!info) continue;
    mods.push({ folder: entry.name, ...info, enabled: active.includes(info.packageName) });
  }
  mods.sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set(mods.map((m) => m.packageName));
  return {
    supported: true,
    workshopDir: p.workshopRel,
    iniExists,
    globalEnabled,
    mods,
    orphanActive: active.filter((a) => !known.has(a)),
  };
}

function writeIni(rec: InstanceRecord, ctx: DriverContext, patch: PalModSettingsPatch): void {
  const p = paths(rec, ctx);
  fs.mkdirSync(p.modsDir, { recursive: true });
  const current = fs.existsSync(p.iniPath) ? fs.readFileSync(p.iniPath, "utf8") : "";
  fs.writeFileSync(p.iniPath, updatePalModSettings(current, patch));
}

export function setWorkshopModEnabled(
  rec: InstanceRecord,
  ctx: DriverContext,
  packageName: string,
  enabled: boolean,
): WorkshopModsStatus {
  const status = getWorkshopModsStatus(rec, ctx);
  if (!status.supported) throw Object.assign(new Error(status.reason ?? "unsupported"), { statusCode: 409 });
  if (!PACKAGE_NAME_RE.test(packageName)) {
    throw Object.assign(new Error(`invalid package name: ${packageName}`), { statusCode: 400 });
  }
  // 允許停用「孤兒」項目(資料夾已刪但 ini 還列著);啟用則必須真的有這個模組。
  if (enabled && !status.mods.some((m) => m.packageName === packageName)) {
    throw Object.assign(new Error(`unknown workshop mod: ${packageName}`), { statusCode: 404 });
  }
  writeIni(rec, ctx, { mod: { packageName, enabled } });
  return getWorkshopModsStatus(rec, ctx);
}

export function setWorkshopGlobalEnabled(rec: InstanceRecord, ctx: DriverContext, enabled: boolean): WorkshopModsStatus {
  const status = getWorkshopModsStatus(rec, ctx);
  if (!status.supported) throw Object.assign(new Error(status.reason ?? "unsupported"), { statusCode: 409 });
  writeIni(rec, ctx, { globalEnabled: enabled });
  return getWorkshopModsStatus(rec, ctx);
}
