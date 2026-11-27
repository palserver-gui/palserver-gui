import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extractZip from "extract-zip";
import type { ModComponent, ModsStatus } from "@palserver/shared";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { serverPlatform } from "./platform.js";
import { serverRoot } from "./native.js";
import * as dockerOps from "./docker.js";
import { execInPod, readFileInPod, writeFileBytesInPod, makeDirInPod, deletePathInPod, resolvePodPath } from "./k8s-files.js";

/**
 * Mod management for native instances (the v1 headline feature, rebuilt):
 *  - PalDefender (formerly PalGuard): standalone anti-cheat, extracted into
 *    Pal/Binaries/Win64 (PalDefender.dll + d3d9.dll proxy loader); its config
 *    tree self-generates under Win64/PalDefender on first boot.
 *    Docs: https://ultimeit.github.io/PalDefender/
 *  - UE4SS: Lua/Blueprint mod loader, extracted into the same dir
 *    (dwmapi.dll + ue4ss/). Lua mods live in ue4ss/Mods, toggled via mods.txt.
 * Both are fetched from their GitHub latest release (URL overridable via env).
 */

const GH_REPOS: Record<
  ModComponent,
  {
    repo: string;
    asset: RegExp;
    assetName?: string;
    betaAsset?: RegExp;
    betaAssetName?: string;
    tag?: string;
    envUrl: string;
  }
> = {
  ue4ss: {
    // Palworld 專用的 Okaetsu fork(experimental-palworld);與 PalSchema 用的同一份,
    // 相容性比上游標準 UE4SS 好。此 release 是固定 tag(非版本號),用 tag 直接鎖定。
    repo: "Okaetsu/RE-UE4SS",
    tag: "experimental-palworld",
    asset: /^UE4SS-Palworld\.zip$/i, // 標準版
    assetName: "UE4SS-Palworld.zip",
    betaAsset: /^UE4SS-Palworld_zDev\.zip$/i, // 開發版(含除錯主控台/工具,體積較大)
    betaAssetName: "UE4SS-Palworld_zDev.zip",
    envUrl: "PALSERVER_UE4SS_URL",
  },
  paldefender: {
    // The wiki names the asset PalDefender_Windows.zip but releases currently
    // ship it as PalDefender.zip — accept both.
    repo: "Ultimeit/PalDefender",
    asset: /^PalDefender(_Windows)?\.zip$/i,
    envUrl: "PALSERVER_PALDEFENDER_URL",
  },
};

const win64Dir = (root: string) => path.join(root, "Pal", "Binaries", "Win64");

/** mod 下載逾時(毫秒):卡住的下載超過這個時間就中止並報錯,避免永遠掛著、累積佔連線。
 *  大檔(UE4SS ~7MB)在正常網路幾秒完成;限速地區走鏡像。3 分鐘是留裕度的上限。 */
const MOD_DOWNLOAD_TIMEOUT_MS = 180_000;

/** Container/Pod 內的遊戲根目錄（docker/k8s Wine image = /palworld, 同 thijsvanloef 慣例）。 */
const CONTAINER_INSTALL_DIR = "/palworld";
const CONTAINER_WIN64_DIR = `${CONTAINER_INSTALL_DIR}/Pal/Binaries/Win64`;
/** k8s writeFileInPod 需要 resolvePodPath 相對路徑（會加 /palworld 前綴）。 */
const POD_WIN64_REL = "Pal/Binaries/Win64";
/** 安裝 marker 在容器/Pod 內的位置(與 native 的 win64 目錄同構)。 */
const POD_MARKER_REL = "Pal/Binaries/Win64/.palserver-mods.json";

/** docker/k8s 下用 exec 偵測檔案是否存在。 */
async function fileExistsInRuntime(rec: InstanceRecord, filePath: string): Promise<boolean> {
  if (rec.backend === "docker") {
    try {
      await dockerOps.execInContainer(rec, ["test", "-f", filePath]);
      return true;
    } catch {
      return false;
    }
  }
  if (rec.backend === "k8s") {
    try {
      await execInPod(rec, ["test", "-f", filePath]);
      return true;
    } catch {
      return false;
    }
  }
  return fs.existsSync(filePath);
}

/** Cheap fs check of which enhancements are installed, for instance summaries. */
export function installedEnhancements(root: string): string[] {
  const out: string[] = [];
  if (fs.existsSync(path.join(win64Dir(root), "PalDefender.dll"))) out.push("PalDefender");
  if (
    fs.existsSync(path.join(win64Dir(root), "ue4ss", "UE4SS.dll")) ||
    fs.existsSync(path.join(win64Dir(root), "UE4SS.dll"))
  ) {
    out.push("UE4SS");
  }
  return out;
}
/** UE4SS mods dir — new layout (ue4ss/Mods) or the flat pre-3.1 layout (Mods). */
const ue4ssModsDir = (root: string) => {
  const nested = path.join(win64Dir(root), "ue4ss", "Mods");
  return fs.existsSync(nested) ? nested : path.join(win64Dir(root), "Mods");
};
const paksDir = (root: string) => path.join(root, "Pal", "Content", "Paks");
/** Marker recording which versions the GUI installed, plus the top-level
 * files each component's archive extracted — so uninstall removes exactly
 * those. Older markers only carry the version strings. */
interface ModsMarker {
  paldefender?: string;
  ue4ss?: string;
  files?: Partial<Record<ModComponent, string[]>>;
}
const markerFile = (root: string) => path.join(win64Dir(root), ".palserver-mods.json");

function readMarker(root: string): ModsMarker {
  try {
    return JSON.parse(fs.readFileSync(markerFile(root), "utf8")) as ModsMarker;
  } catch {
    return {};
  }
}

function writeMarker(root: string, component: ModComponent, version: string, files?: string[]): void {
  const marker = readMarker(root);
  marker[component] = version;
  if (files) marker.files = { ...(marker.files ?? {}), [component]: files };
  fs.writeFileSync(markerFile(root), JSON.stringify(marker, null, 2));
}

async function extractZipTracked(zipPath: string, dir: string): Promise<string[]> {
  const top = new Set<string>();
  await extractZip(zipPath, {
    dir,
    onEntry: (entry) => {
      const seg = entry.fileName.replace(/^\.\//, "").split(/[\\/]/)[0];
      if (seg) top.add(seg);
    },
  });
  return [...top];
}

/** Fallback removal set for mods installed before we tracked files. Excludes
 * any shared proxy DLL to avoid breaking the other component. */
const DEFAULT_MOD_FILES: Record<ModComponent, string[]> = {
  paldefender: ["PalDefender.dll", "PalDefender"],
  ue4ss: ["UE4SS.dll", "UE4SS-settings.ini", "ue4ss", "Mods"],
};

const DISABLED_SUFFIX = ".palserver-disabled";

/** 改名後的檔名(尾碼只加一次)。 */
export function disabledName(name: string): string {
  return name.endsWith(DISABLED_SUFFIX) ? name : name + DISABLED_SUFFIX;
}

/** k8s/docker 共用的 mv argv:把 rel(相對容器根,如 Pal/Binaries/Win64/X.dll)
 *  在啟用/停用間改名。argv 原樣進容器,路徑用 /palworld 絕對形式。 */
export function renameCommandArgs(rel: string, enable: boolean): string[] {
  const from = enable ? disabledName(rel) : rel;
  const to = enable ? rel : disabledName(rel);
  return ["mv", resolvePodPath(from), resolvePodPath(to)];
}

/** 「目前是否啟用」的三態計算(active 優先,與 native componentState 同構);
 *  兩者皆無 = 未安裝(null)。 */
export function enabledFromFiles(active: boolean, disabled: boolean): boolean | null {
  if (active) return true;
  return disabled ? false : null;
}

/** runtime 缺席錯誤判定:k8s = podOf 的「找不到運行中的 game-server Pod」;
 *  docker = findContainer 的「找不到容器」,或對停止/暫停容器 exec 的 409。 */
export function isPodMissingError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.message.includes("找不到運行中的 game-server Pod") || e.message.includes("找不到容器")) {
    return true;
  }
  // dockerode/docker-modem 對停止/暫停容器 exec 以 409 回報(訊息形如
  // "(HTTP code 409) container stopped/paused - Container <id> is not running",
  // 帶 statusCode:409)。exec 路徑上 docker 的 409 只有缺席/未運行兩種,
  // 以 statusCode 判定誤配面可控。
  const sc = (e as Error & { statusCode?: number }).statusCode;
  return sc === 409 || /is not running/i.test(e.message);
}

/** Pod/容器缺席時的人話 409:讓使用者知道下一步是啟動伺服器,而非 exec 技術錯誤。 */
export function podMissingError(backend: "docker" | "k8s"): Error {
  const what = backend === "docker" ? "容器未運行" : "伺服器未運行";
  return Object.assign(new Error(`${what}:請先啟動伺服器再管理模組`), { statusCode: 409 });
}

/** 容器/Pod 內的 exec 檔案存在性——與 fileExistsInRuntime 不同,缺席時**不吞錯**:
 *  runtime 缺席錯誤轉 409 人話上拋,其餘 exec 錯誤視為「檔案不存在」。
 *  docker 腳必須用 exit-code 檢查版(execInContainerChecked):無檢查版的
 *  `test -f` 結果會被無視,一切檔案「都存在」→ 停用/啟用假成功。 */
async function execFileExistsInRuntime(rec: InstanceRecord, absPath: string): Promise<boolean> {
  const args = ["test", "-f", absPath];
  try {
    if (rec.backend === "docker") await dockerOps.execInContainerChecked(rec, args);
    else await execInPod(rec, args);
    return true;
  } catch (e) {
    if (isPodMissingError(e)) throw podMissingError(rec.backend === "docker" ? "docker" : "k8s");
    return false;
  }
}

/** 各元件「停用時改名」的目標 DLL(相對 win64)。 */
const DISABLE_TARGETS: Record<ModComponent, string[]> = {
  ue4ss: ["UE4SS.dll", "ue4ss/UE4SS.dll", "UE4SS/UE4SS.dll"],
  paldefender: ["PalDefender.dll"],
};

function componentState(root: string, component: ModComponent): { installed: boolean; enabled: boolean } {
  let active = false;
  let disabled = false;
  for (const rel of DISABLE_TARGETS[component]) {
    if (fs.existsSync(path.join(win64Dir(root), rel))) active = true;
    if (fs.existsSync(path.join(win64Dir(root), rel + DISABLED_SUFFIX))) disabled = true;
  }
  return { installed: active || disabled, enabled: active };
}

/** 暫時停用/重新啟用(不刪任何檔):把主 DLL 改名加 .palserver-disabled 尾碼。
 *  改版日的安全退路 —— 移除會連使用者的 Lua 模組一起刪,停用不會。
 *  native Windows:檔案在本機,需伺服器停止(DLL 鎖定),改名後下次啟動生效。
 *  docker/k8s:檔案在容器/Pod 內,需伺服器**運行中**(exec 改名),同樣重啟後生效。 */
export async function setModEnabled(
  rec: InstanceRecord,
  ctx: DriverContext,
  component: ModComponent,
  enabled: boolean,
): Promise<void> {
  // docker/k8s: exec into the container/Pod (PVC 持久,改名跨 Pod 重啟保留)。
  if (rec.backend === "docker" || rec.backend === "k8s") {
    for (const rel of DISABLE_TARGETS[component]) {
      // rel 是「相對 win64」路徑;renameCommandArgs 的契約是 Pod 相對路徑(帶
      // Pal/Binaries/Win64 前綴),缺這層會解析成 /palworld/PalDefender.dll。
      const podRel = `${POD_WIN64_REL}/${rel}`;
      const active = await execFileExistsInRuntime(rec, `${CONTAINER_WIN64_DIR}/${rel}`);
      const disabled = await execFileExistsInRuntime(rec, `${CONTAINER_WIN64_DIR}/${rel}${DISABLED_SUFFIX}`);
      if (enabled && disabled) await execRenameInRuntime(rec, renameCommandArgs(podRel, true));
      if (!enabled && active) await execRenameInRuntime(rec, renameCommandArgs(podRel, false));
    }
    return;
  }
  if (rec.backend !== "native" || serverPlatform(rec) !== "windows") {
    throw Object.assign(
      new Error("停用/啟用僅支援原生模式或 docker/k8s 後端的 Windows 伺服器(含 Linux 上以 Wine 執行的 Windows binary)"),
      { statusCode: 409 },
    );
  }
  const root = serverRoot(rec, ctx);
  for (const rel of DISABLE_TARGETS[component]) {
    const active = path.join(win64Dir(root), rel);
    const off = active + DISABLED_SUFFIX;
    if (enabled && fs.existsSync(off)) fs.renameSync(off, active);
    if (!enabled && fs.existsSync(active)) fs.renameSync(active, off);
  }
}

/** 容器/Pod 內改名;runtime 缺席錯誤轉 409 人話。docker 用 exit-code 檢查版,
 *  mv 失敗(如目標不存在)如實上拋,不假成功。 */
async function execRenameInRuntime(rec: InstanceRecord, args: string[]): Promise<void> {
  try {
    if (rec.backend === "docker") await dockerOps.execInContainerChecked(rec, args);
    else await execInPod(rec, args);
  } catch (e) {
    if (isPodMissingError(e)) throw podMissingError(rec.backend === "docker" ? "docker" : "k8s");
    throw e;
  }
}

/** marker 讀寫的 backend 分流:docker 走 execInContainer base64(寫)／cat(讀),
 *  k8s 走 k8s-files 專用 API(writeFileBytesInPod/readFileInPod 走 podOf,不支援 docker)。 */
async function writeMarkerInRuntime(rec: InstanceRecord, rel: string, data: Buffer): Promise<void> {
  if (rec.backend === "docker") {
    const b64 = data.toString("base64");
    await dockerOps.execInContainerChecked(rec, [
      "sh",
      "-c",
      `echo '${b64}' | base64 -d > '${resolvePodPath(rel)}'`,
    ]);
  } else {
    await writeFileBytesInPod(rec, rel, data);
  }
}

async function readMarkerInRuntime(rec: InstanceRecord, rel: string): Promise<string> {
  if (rec.backend === "docker") {
    return await dockerOps.execInContainerChecked(rec, ["cat", resolvePodPath(rel)]);
  }
  return await readFileInPod(rec, rel);
}

export async function getModsStatus(rec: InstanceRecord, ctx: DriverContext): Promise<ModsStatus> {
  const unsupported = (reason: string, serverInstalled = true): ModsStatus => ({
    supported: false,
    reason,
    serverInstalled,
    ue4ss: { installed: false, version: null },
    paldefender: { installed: false, version: null },
    luaMods: [],
    luaModsDir: null,
    pakMods: [],
  });

  if (serverPlatform(rec) !== "windows") {
    return unsupported("模組管理需要 Windows 伺服器(UE4SS/PalDefender 是 Windows DLL,在非 Windows binary 上無法載入)");
  }

  // docker/k8s: 容器/Pod 內 exec 偵測（host fs 看不到容器內的 Win64 目錄）。
  // Pod 缺席（伺服器停機）時優雅降級：回 supported:false＋人話 reason，GUI 據此
  // 顯示「請先啟動伺服器」引導——不擲 500 打碎整頁。
  if (rec.backend === "docker" || rec.backend === "k8s") {
    const empty: ModsStatus = {
      supported: false,
      serverInstalled: true,
      ue4ss: { installed: false, version: null },
      paldefender: { installed: false, version: null },
      luaMods: [],
      luaModsDir: null,
      pakMods: [],
    };
    try {
      const pdActive = await execFileExistsInRuntime(rec, `${CONTAINER_WIN64_DIR}/PalDefender.dll`);
      const pdDisabled = await execFileExistsInRuntime(
        rec,
        `${CONTAINER_WIN64_DIR}/PalDefender.dll.palserver-disabled`,
      );
      const ue4ssActive =
        (await execFileExistsInRuntime(rec, `${CONTAINER_WIN64_DIR}/ue4ss/UE4SS.dll`)) ||
        (await execFileExistsInRuntime(rec, `${CONTAINER_WIN64_DIR}/UE4SS.dll`));
      const ue4ssDisabled =
        (await execFileExistsInRuntime(rec, `${CONTAINER_WIN64_DIR}/ue4ss/UE4SS.dll.palserver-disabled`)) ||
        (await execFileExistsInRuntime(rec, `${CONTAINER_WIN64_DIR}/UE4SS.dll.palserver-disabled`));
      const pdEnabled = enabledFromFiles(pdActive, pdDisabled);
      const ue4ssEnabled = enabledFromFiles(ue4ssActive, ue4ssDisabled);
      // marker 在 Pod 內（install 時寫入）；讀不到（舊安裝/首次）回 null。
      let marker: ModsMarker = {};
      try {
        marker = JSON.parse(await readMarkerInRuntime(rec, POD_MARKER_REL)) as ModsMarker;
      } catch { /* 無 marker = 舊安裝或 Pod 缺席路徑已被上層轉譯 */ }
      return {
        supported: true,
        serverInstalled: true,
        ue4ss: {
          installed: ue4ssEnabled !== null,
          version: marker.ue4ss ?? null,
          enabled: ue4ssEnabled ?? undefined,
        },
        paldefender: {
          installed: pdEnabled !== null,
          version: marker.paldefender ?? null,
          enabled: pdEnabled ?? undefined,
        },
        luaMods: [],
        luaModsDir: null,
        pakMods: [],
      };
    } catch (e) {
      if (isPodMissingError(e) || (e instanceof Error && e.message.includes("請先啟動伺服器"))) {
        return { ...empty, supported: false, reason: (e as Error).message };
      }
      throw e;
    }
  }

  const root = serverRoot(rec, ctx);
  if (!fs.existsSync(win64Dir(root))) {
    return unsupported("伺服器尚未安裝完成 — 先啟動一次讓 agent 下載伺服器", false);
  }

  const marker = readMarker(root);
  const ue4ssState = componentState(root, "ue4ss");
  const paldefenderState = componentState(root, "paldefender");
  const ue4ssInstalled = ue4ssState.installed;
  const paldefenderInstalled = paldefenderState.installed;

  const modsDir = ue4ssModsDir(root);
  return {
    supported: true,
    serverInstalled: true,
    ue4ss: { installed: ue4ssInstalled, version: marker.ue4ss ?? null, enabled: ue4ssState.enabled },
    paldefender: { installed: paldefenderInstalled, version: marker.paldefender ?? null, enabled: paldefenderState.enabled },
    luaMods: listLuaMods(root),
    luaModsDir: fs.existsSync(modsDir)
      ? path.relative(root, modsDir).split(path.sep).join("/")
      : null,
    pakMods: listPakMods(root),
  };
}

function listLuaMods(root: string): { name: string; enabled: boolean }[] {
  const dir = ue4ssModsDir(root);
  if (!fs.existsSync(dir)) return [];
  const enabledFromTxt = parseModsTxt(root);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "shared")
    .map((e) => ({
      name: e.name,
      enabled:
        enabledFromTxt.get(e.name) === true ||
        fs.existsSync(path.join(dir, e.name, "enabled.txt")),
    }));
}

function parseModsTxt(root: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  const file = path.join(ue4ssModsDir(root), "mods.txt");
  if (!fs.existsSync(file)) return result;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.trim().match(/^([\w-]+)\s*:\s*([01])$/);
    if (match) result.set(match[1], match[2] === "1");
  }
  return result;
}

function listPakMods(root: string): string[] {
  const results: string[] = [];
  const scan = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".pak") && !entry.name.startsWith("Pal-")) {
        results.push(prefix + entry.name);
      }
      if (entry.isDirectory() && entry.name === "LogicMods") {
        scan(path.join(dir, entry.name), "LogicMods/");
      }
    }
  };
  scan(paksDir(root), "");
  return results;
}

export function setLuaModEnabled(
  rec: InstanceRecord,
  ctx: DriverContext,
  name: string,
  enabled: boolean,
): void {
  const root = serverRoot(rec, ctx);
  const modDir = path.join(ue4ssModsDir(root), name);
  if (!/^[\w-]+$/.test(name) || !fs.existsSync(modDir)) {
    throw Object.assign(new Error(`unknown lua mod: ${name}`), { statusCode: 404 });
  }
  // enabled.txt overrides mods.txt, so clear it when disabling.
  if (!enabled) fs.rmSync(path.join(modDir, "enabled.txt"), { force: true });

  const file = path.join(ue4ssModsDir(root), "mods.txt");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  const flag = `${name} : ${enabled ? 1 : 0}`;
  const idx = lines.findIndex((l) => l.trim().startsWith(`${name} `) || l.trim().startsWith(`${name}:`));
  if (idx >= 0) lines[idx] = flag;
  else lines.unshift(flag);
  fs.writeFileSync(file, lines.join("\n"));
}

interface GitRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  assets: { name: string; browser_download_url: string; updated_at?: string }[];
}

/** release 的顯示版本。固定 tag 的元件(如 UE4SS Okaetsu experimental-palworld)tag 不會變,
 *  改用「標準資產的建置日期(updated_at)」當版本 —— 這樣才標得出版本、且 Okaetsu 重新上傳新
 *  建置時(同 tag、新日期)偵測得到「有新版」。非固定 tag 的元件照用 tag_name。 */
function releaseVersion(component: ModComponent, release: GitRelease): string {
  const cfg = GH_REPOS[component];
  if (cfg.tag) {
    const asset = release.assets.find((a) => cfg.asset.test(a.name));
    const date = asset?.updated_at?.slice(0, 10); // YYYY-MM-DD
    return date ? `${cfg.tag} (${date})` : cfg.tag;
  }
  return release.tag_name;
}

/**
 * 固定 tag 資產可直接下載,不需要 GitHub REST API。HEAD 跟隨到 CDN 後用 Last-Modified 當建置日期版本;
 * 直鏈不存在才回 null 讓呼叫端走 API 相容路徑。
 * 版本日期一律取「標準版資產」——更新徽章(latestModVersions)永遠查 stable,beta(zDev)已裝版本
 * 也用同一來源,兩者才不會因兩個資產上傳時刻不同而被誤判成「有新版」(固定 tag 的資產同屬一個 release、
 * 一起發布)。下載連結(url)仍依 channel 指向對的資產(stable=標準版、beta=zDev)。
 */
export async function resolveFixedTagDownload(
  component: ModComponent,
  channel: "stable" | "beta",
): Promise<{ version: string; url: string } | null> {
  const cfg = GH_REPOS[component];
  if (!cfg.tag) return null;
  const dlName = channel === "beta" ? (cfg.betaAssetName ?? cfg.assetName) : cfg.assetName;
  if (!dlName) return null;
  // 版本日期一律以標準版資產為準(見上方註解);缺 assetName 才退回下載用的資產名。
  const verName = cfg.assetName ?? dlName;
  const assetUrl = (name: string) =>
    `https://github.com/${cfg.repo}/releases/download/${encodeURIComponent(cfg.tag!)}/${encodeURIComponent(name)}`;
  const dlUrl = assetUrl(dlName);
  try {
    const res = await fetch(assetUrl(verName), {
      method: "HEAD",
      redirect: "follow",
      headers: { "user-agent": "palserver-gui" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const modified = res.headers.get("last-modified");
    const timestamp = modified ? Date.parse(modified) : NaN;
    const date = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
    return { version: date ? `${cfg.tag} (${date})` : cfg.tag, url: dlUrl };
  } catch {
    return null;
  }
}

/** 各元件的最新穩定版 tag(6 小時記憶體快取;查詢失敗回 null,不丟錯)。
 *  給「有新版可更新」徽章用 —— 改版日玩家最需要知道模組能不能更了。 */
const latestCache = new Map<ModComponent, { tag: string | null; at: number }>();
const LATEST_TTL = 6 * 60 * 60 * 1000;
export async function latestModVersions(): Promise<Record<ModComponent, string | null>> {
  const out = {} as Record<ModComponent, string | null>;
  for (const component of ["ue4ss", "paldefender"] as ModComponent[]) {
    const hit = latestCache.get(component);
    if (hit && Date.now() - hit.at < LATEST_TTL) {
      out[component] = hit.tag;
      continue;
    }
    try {
      const cfg = GH_REPOS[component];
      if (cfg.tag) {
        const direct = await resolveFixedTagDownload(component, "stable");
        if (direct) {
          latestCache.set(component, { tag: direct.version, at: Date.now() });
          out[component] = direct.version;
          continue;
        }
      }
      // 固定 tag 的元件(如 UE4SS Okaetsu fork)直接查該 tag,否則查 latest。
      const endpoint = cfg.tag
        ? `https://api.github.com/repos/${cfg.repo}/releases/tags/${cfg.tag}`
        : `https://api.github.com/repos/${cfg.repo}/releases/latest`;
      const res = await fetch(endpoint, {
        headers: { "user-agent": "palserver-gui", accept: "application/vnd.github+json" },
      });
      const tag = res.ok ? releaseVersion(component, (await res.json()) as GitRelease) : null;
      latestCache.set(component, { tag, at: Date.now() });
      out[component] = tag;
    } catch {
      latestCache.set(component, { tag: null, at: Date.now() });
      out[component] = null;
    }
  }
  return out;
}

async function resolveDownload(
  component: ModComponent,
  channel: "stable" | "beta",
): Promise<{ version: string; url: string }> {
  const { repo, asset, betaAsset, tag, envUrl } = GH_REPOS[component];
  const override = process.env[envUrl];
  if (override) return { version: "custom", url: override };

  const direct = await resolveFixedTagDownload(component, channel);
  if (direct) return direct;

  // 固定 tag 的元件(UE4SS Okaetsu fork = experimental-palworld)兩個通道都用同一 release,
  // 靠不同資產區分(stable=標準版、beta=zDev 開發版)。否則:stable="latest"(排除 pre-release)、
  // beta 掃 release 清單取最新(含 pre-release)。
  const endpoint = tag
    ? `https://api.github.com/repos/${repo}/releases/tags/${tag}`
    : channel === "beta"
      ? `https://api.github.com/repos/${repo}/releases?per_page=15`
      : `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetch(endpoint, {
    headers: { "user-agent": "palserver-gui", accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub release lookup failed for ${repo}: HTTP ${res.status}`);

  const body = await res.json();
  const release: GitRelease | undefined =
    !tag && channel === "beta" ? (body as GitRelease[]).filter((r) => !r.draft).at(0) : (body as GitRelease);
  if (!release) throw new Error(`no releases found for ${repo}`);

  // beta 通道若有專屬資產(如 UE4SS zDev)就用它,否則沿用標準資產。
  const pattern = channel === "beta" && betaAsset ? betaAsset : asset;
  const match = release.assets.find((a) => pattern.test(a.name));
  if (!match) {
    throw new Error(
      `no matching asset in ${repo}@${release.tag_name} (looked for ${pattern}); ` +
        `set ${envUrl} to pin a download URL`,
    );
  }
  return { version: releaseVersion(component, release), url: match.browser_download_url };
}

export async function installComponent(
  rec: InstanceRecord,
  ctx: DriverContext,
  component: ModComponent,
  channel: "stable" | "beta" = "stable",
  /** 直接指定下載 URL(繞過 GitHub release 解析);給限速地區走鏡像用。資產格式須與該元件相同。 */
  urlOverride?: string,
): Promise<{ version: string }> {
  const status = await getModsStatus(rec, ctx);
  if (!status.supported) {
    throw Object.assign(new Error(status.reason ?? "mods unsupported"), { statusCode: 409 });
  }

  const { version, url } = urlOverride
    ? { version: "custom", url: urlOverride }
    : await resolveDownload(component, channel);
  // 下載加逾時:沒有 signal 時,連線卡住(慢速 CDN / 對端不回)會讓 fetch 永遠掛著,
  // 且 HTTP 客戶端斷線也不會中止 server 端下載 → 卡住的下載會累積、佔住連線。逾時就中止並報錯。
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(MOD_DOWNLOAD_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw Object.assign(
        new Error(
          `下載逾時(超過 ${Math.round(MOD_DOWNLOAD_TIMEOUT_MS / 1000)}s):連線過慢或對端無回應。` +
            `限速地區可改用鏡像(install 帶 url,或設 ${GH_REPOS[component].envUrl})。來源:${url}`,
        ),
        { statusCode: 504 },
      );
    }
    throw e;
  }
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const zipBuffer = Buffer.from(await res.arrayBuffer());

  // docker/k8s: download to host, extract, then transfer into container/Pod.
  if (rec.backend === "docker" || rec.backend === "k8s") {
    return installComponentInRuntime(rec, component, version, zipBuffer);
  }

  // native: extract directly on host fs.
  const root = serverRoot(rec, ctx);
  fs.mkdirSync(ctx.instanceDir, { recursive: true });
  const zipPath = path.join(ctx.instanceDir, `${component}.zip`);
  fs.writeFileSync(zipPath, zipBuffer);
  const files = await extractZipTracked(zipPath, win64Dir(root));
  fs.rmSync(zipPath, { force: true });
  writeMarker(root, component, version, files);
  return { version };
}

/** Install a mod component into a docker container or k8s Pod via exec/archive. */
async function installComponentInRuntime(
  rec: InstanceRecord,
  component: ModComponent,
  version: string,
  zipBuffer: Buffer,
): Promise<{ version: string }> {
  const containerWin64 = CONTAINER_WIN64_DIR;
  // PVC = /palworld (entire install persisted); DLLs survive Pod restarts.
  const persistentWin64 = containerWin64;
  // Extract on host to a temp dir, then transfer each file via exec.
  const tmpDir = path.join(os.tmpdir(), `palserver-mod-${component}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, `${component}.zip`), zipBuffer);
  const files = await extractZipTracked(path.join(tmpDir, `${component}.zip`), tmpDir);
  fs.rmSync(path.join(tmpDir, `${component}.zip`), { force: true });

  // Ensure Win64 dir exists (DepotDownloader may still be running on first boot).
  if (rec.backend === "docker") {
    await dockerOps.execInContainer(rec, ["mkdir", "-p", persistentWin64]);
  } else {
    // k8s: retry until Win64 exists (DepotDownloader creates it).
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const exists = await fileExistsInRuntime(rec, `${CONTAINER_WIN64_DIR}/PalServer-Win64-Shipping-Cmd.exe`);
        if (exists) break;
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 10000));
    }
    await execInPod(rec, ["mkdir", "-p", persistentWin64]);
  }

  // Transfer each extracted file/directory into the container/Pod.
  for (const rel of files) {
    const localPath = path.join(tmpDir, rel);
    const remotePath = `${persistentWin64}/${rel}`;
    if (fs.statSync(localPath).isDirectory()) {
      if (rec.backend === "docker") {
        await dockerOps.execInContainer(rec, ["mkdir", "-p", remotePath]);
      } else {
        await execInPod(rec, ["mkdir", "-p", remotePath]);
      }
      await transferDirToRuntime(rec, localPath, remotePath);
    } else {
      await transferFileToRuntime(rec, localPath, remotePath);
    }
  }

  // Clean up host temp.
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // 寫安裝 marker 進容器/Pod(與 native 同構,供 status 回報 version 顯示「有新版」)。
  // 先讀後寫合併,保留另一元件的欄位。
  let marker: ModsMarker = {};
  try {
    marker = JSON.parse(await readMarkerInRuntime(rec, POD_MARKER_REL)) as ModsMarker;
  } catch { /* 無 marker = 首次安裝 */ }
  marker[component] = version;
  marker.files = { ...(marker.files ?? {}), [component]: files };
  await writeMarkerInRuntime(rec, POD_MARKER_REL, Buffer.from(JSON.stringify(marker, null, 2)));
  return { version };
}

async function transferFileToRuntime(rec: InstanceRecord, localPath: string, remotePath: string): Promise<void> {
  const data = fs.readFileSync(localPath);
  if (rec.backend === "docker") {
    // docker: putArchive or base64 over exec. Base64 is simpler for small DLLs.
    const b64 = data.toString("base64");
    await dockerOps.execInContainer(rec, ["sh", "-c", `echo '${b64}' | base64 -d > '${remotePath}'`]);
  } else {
    // k8s: writeFileBytesInPod uses resolvePodPath (prepends /palworld).
    const relPath = remotePath.replace(/^\/palworld\//, "");
    await writeFileBytesInPod(rec, relPath, data);
  }
}

async function transferDirToRuntime(rec: InstanceRecord, localDir: string, remoteDir: string): Promise<void> {
  for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = `${remoteDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (rec.backend === "docker") {
        await dockerOps.execInContainer(rec, ["mkdir", "-p", remotePath]);
      } else {
        const relPath = remotePath.replace(/^\/palworld\//, "");
        await makeDirInPod(rec, relPath);
      }
      await transferDirToRuntime(rec, localPath, remotePath);
    } else {
      await transferFileToRuntime(rec, localPath, remotePath);
    }
  }
}

/** Uninstall a component: remove the files its install extracted (tracked in
 * the marker; falls back to known defaults for older installs). Never removes
 * a file the other still-installed component also claims, so removing one mod
 * can't break the other. Caller must ensure the server is stopped (DLLs are
 * locked while running). */
export async function removeComponent(
  rec: InstanceRecord,
  ctx: DriverContext,
  component: ModComponent,
): Promise<void> {
  const status = await getModsStatus(rec, ctx);
  if (!status.supported) {
    throw Object.assign(new Error(status.reason ?? "mods unsupported"), { statusCode: 409 });
  }

  // docker/k8s: remove files inside container/Pod via exec.
  if (rec.backend === "docker" || rec.backend === "k8s") {
    const other: ModComponent = component === "ue4ss" ? "paldefender" : "ue4ss";
    const keep = new Set(status[other].installed ? DEFAULT_MOD_FILES[other] : []);
    const targets = DEFAULT_MOD_FILES[component].filter((f) => !keep.has(f));
    for (const rel of targets) {
      const remotePath = `${CONTAINER_WIN64_DIR}/${rel}`;
      if (rec.backend === "docker") {
        await dockerOps.execInContainer(rec, ["rm", "-rf", remotePath]).catch(() => {});
      } else {
        // deletePathInPod uses resolvePodPath (prepends /palworld); strip prefix.
        const relPath = remotePath.replace(/^\/palworld\//, "");
        await deletePathInPod(rec, relPath).catch(() => {});
      }
    }
    return;
  }

  // native: remove on host fs.
  const root = serverRoot(rec, ctx);
  const w64 = win64Dir(root);
  const marker = readMarker(root);

  const other: ModComponent = component === "ue4ss" ? "paldefender" : "ue4ss";
  const keep = new Set(
    status[other].installed ? (marker.files?.[other] ?? DEFAULT_MOD_FILES[other]) : [],
  );
  const targets = (
    marker.files?.[component]?.length ? marker.files[component]! : DEFAULT_MOD_FILES[component]
  ).filter((f) => !keep.has(f));

  for (const rel of targets) {
    const p = path.resolve(w64, rel);
    if (p === w64 || !p.startsWith(w64 + path.sep)) continue;
    fs.rmSync(p, { recursive: true, force: true });
  }

  delete marker[component];
  if (marker.files) delete marker.files[component];
  fs.writeFileSync(markerFile(root), JSON.stringify(marker, null, 2));
}
