#!/usr/bin/env node
/**
 * 從 paldb.cc 抓帕魯/道具的多語言名稱,並重建玩家科技目錄。
 * 帕魯/道具名稱合併進 packages/web/public/game-data/{items,pals}.json;
 * 科技則從四語 /Technologies 頁完整產生 technologies.json 與缺少的圖示。
 *
 * 資料來源:paldb.cc 的 /en、/tw、/cn、/ja 索引頁(維護者為 paldb.cc 貢獻者,
 * 已獲同意抓取;見 public/game-data/CREDITS.md)。
 *
 * 帕魯/道具的簡中不在這裡抓:上游簡中(zhCN 欄位)由
 * scripts/fetch-zh-cn.mjs 負責;科技的四語完整清單則由本腳本直接重建。
 * "zh-CN" 欄位是人工校對譯名,任何抓取腳本都不得寫入,只保留原值。
 *
 * 用法:node scripts/fetch-game-data-i18n.mjs [items|pals|technologies ...]
 * 不帶參數時更新全部目錄;可只傳 technologies 單獨更新科技。
 * 之後遊戲改版要更新名稱,重跑一次再 commit 即可。
 */
import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "packages/web/public/game-data");
const TECHNOLOGY_ICON_DIR = path.join(DATA_DIR, "technologies");
const UA = "palserver-gui-data-sync (maintainer-approved; github.com/io-software-ai/palserver-gui)";
const LANGS = [
  ["en", "en"],
  ["tw", "zh"],
  ["ja", "ja"],
  // FORK 추가: 한국어. paldb 미번역 항목은 "-" 나 "ko_Text" 를 뱉으므로 아래 isPlaceholder 로 거른다.
  ["ko", "ko"],
];
const TECHNOLOGY_LANGS = [
  ["en", "name"],
  ["tw", "zh"],
  ["cn", "zhCN"],
  ["ja", "ja"],
];
/** paldb 未翻譯欄位的佔位字串("-"、"ko_Text"、"zh-Hant Text"…)—— 當成沒有名字。 */
const isPlaceholder = (s) => !s || s === "-" || /(^|[\s_-])Text$/.test(s);

const requestedTargets = new Set(process.argv.slice(2));
const shouldUpdate = (target) => requestedTargets.size === 0 || requestedTargets.has(target);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage(lang, page) {
  const res = await fetch(`https://paldb.cc/${lang}/${page}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`paldb.cc/${lang}/${page} -> HTTP ${res.status}`);
  return res.text();
}

/** 解析索引頁:data-hover="?s=<kind>%2F<內部ID>" 的連結文字就是該語言名稱。
 *  名稱可能包住 <span>(稀有度上色),抓 inner HTML 再剝掉標籤。 */
function parseNames(html, kind) {
  const names = new Map();
  const re = new RegExp(
    `<a class="itemname" data-hover="\\?s=${kind}%2F([^"]+)"[^>]*>(.*?)</a>`,
    "gs",
  );
  for (const [, rawId, rawName] of html.matchAll(re)) {
    const id = decodeURIComponent(rawId);
    const name = rawName.replace(/<[^>]*>/g, "").trim();
    if (name && !names.has(id)) names.set(id, name);
  }
  return names;
}

/** FORK: 英文名 → paldb 頁面 slug(空白換底線),href 對應用。 */
const slugify = (name) => name.trim().replace(/\s+/g, "_");

/** FORK: data-hover 是快取雜湊(沒有內部 ID)的 itemname 連結 —— 用 href 的英文 slug 當鍵。
 *  例:<a class="itemname" data-hover="/cache/ko/Game_Items_hover/5fa1…" href="Carbon_Fiber">카본 섬유</a> */
function parseNamesByHref(html) {
  const names = new Map();
  const re = /<a class="itemname" data-hover="\/cache\/[^"]*" href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  for (const [, href, rawName] of html.matchAll(re)) {
    const name = rawName.replace(/<[^>]*>/g, "").trim();
    if (name && !names.has(href)) names.set(href, name);
  }
  return names;
}

/** /Technologies 每張卡片直接提供科技 ID、顯示名與圖示 URL。 */
function parseTechnologies(html) {
  const technologies = new Map();
  const re =
    /<div class="d-inline-block hoverTech[^"]*" style="background-image: url\(([^)]*)\);" data-hover="\?s=Technology\/([^"]+)">[\s\S]*?<div class="hoverTechFooter">([\s\S]*?)<\/div>/g;
  for (const [, iconUrl, rawId, rawName] of html.matchAll(re)) {
    const id = decodeURIComponent(rawId);
    const name = rawName.replace(/<[^>]*>/g, "").trim();
    const key = id.toLowerCase();
    if (name && !technologies.has(key)) technologies.set(key, { id, name, iconUrl });
  }
  return technologies;
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function downloadIcon(url, dest) {
  if (await fileExists(dest)) return true;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return false;
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function updateTechnologies() {
  const pages = new Map();
  for (const [site] of TECHNOLOGY_LANGS) {
    if (pages.size > 0) await sleep(400);
    pages.set(site, parseTechnologies(await fetchPage(site, "Technologies")));
  }

  const english = pages.get("en");
  if (!english || english.size === 0) throw new Error("paldb.cc/en/Technologies 沒有解析到科技");
  for (const [site] of TECHNOLOGY_LANGS) {
    const catalog = pages.get(site);
    const missingIds = [...english.keys()].filter((id) => !catalog?.has(id));
    if (catalog?.size !== english.size || missingIds.length > 0) {
      throw new Error(
        `paldb.cc/${site}/Technologies 無法與英文頁對齊: ` +
          `${catalog?.size ?? 0}/${english.size},缺少 ${missingIds.slice(0, 5).join(", ")}`,
      );
    }
  }

  let existing = [];
  try {
    existing = JSON.parse(await readFile(path.join(DATA_DIR, "technologies.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const reviewedById = new Map(
    existing.filter((entry) => entry["zh-CN"]).map((entry) => [entry.id.toLowerCase(), entry["zh-CN"]]),
  );
  const items = JSON.parse(await readFile(path.join(DATA_DIR, "items.json"), "utf8"));
  const itemById = new Map(items.map((entry) => [entry.id.toLowerCase(), entry]));

  await mkdir(TECHNOLOGY_ICON_DIR, { recursive: true });
  const technologies = [];
  const referencedTechnologyIcons = new Set();
  let reusedItemIcons = 0;
  let downloadedTechnologyIcons = 0;
  let missingIcons = 0;

  for (const [key, source] of english) {
    const names = Object.fromEntries(
      TECHNOLOGY_LANGS.map(([site, field]) => [field, pages.get(site)?.get(key)?.name]),
    );
    const reviewed = reviewedById.get(key);
    let icon;
    const iconUrl = source.iconUrl;
    const basename = iconUrl ? path.basename(new URL(iconUrl).pathname) : "";
    const localItemIcon = basename ? path.join(DATA_DIR, "items", basename) : "";

    if (basename && (await fileExists(localItemIcon))) {
      icon = `items/${basename}`;
      reusedItemIcons++;
    } else if (basename) {
      const dest = path.join(TECHNOLOGY_ICON_DIR, basename);
      if (await downloadIcon(iconUrl, dest)) {
        icon = `technologies/${basename}`;
        referencedTechnologyIcons.add(basename);
        downloadedTechnologyIcons++;
        await sleep(150); // 禮貌節流,比照 fetch-human-npcs.mjs(維護者與 paldb.cc 的約定)
      }
    } else {
      // PalDB 偶爾會讓科技卡片暫時缺圖;同 ID 道具的 PalDB 圖示可安全後備。
      const itemIcon = itemById.get(key)?.icon;
      if (itemIcon && (await fileExists(path.join(DATA_DIR, "items", itemIcon)))) {
        icon = `items/${itemIcon}`;
        reusedItemIcons++;
      }
    }
    if (!icon) missingIcons++;

    technologies.push({
      id: source.id,
      name: names.name,
      ...(icon ? { icon } : {}),
      ...(names.zh ? { zh: names.zh } : {}),
      ...(reviewed ? { "zh-CN": reviewed } : {}),
      ...(names.zhCN ? { zhCN: names.zhCN } : {}),
      ...(names.ja ? { ja: names.ja } : {}),
    });
  }

  // technologies/ 只放目前目錄實際引用的 PalDB 圖示,避免改版後留下孤兒檔案。
  let removedIcons = 0;
  for (const file of await readdir(TECHNOLOGY_ICON_DIR)) {
    if (!referencedTechnologyIcons.has(file)) {
      await unlink(path.join(TECHNOLOGY_ICON_DIR, file));
      removedIcons++;
    }
  }

  await writeFile(path.join(DATA_DIR, "technologies.json"), JSON.stringify(technologies) + "\n");
  console.log(
    `technologies.json: ${technologies.length} entries ` +
      `(items icons ${reusedItemIcons}; technology icons ${downloadedTechnologyIcons}; ` +
      `missing ${missingIcons}; removed stale ${removedIcons})`,
  );
}

async function updateCatalog(file, page, kind) {
  const catalog = JSON.parse(await readFile(path.join(DATA_DIR, file), "utf8"));
  const stats = {};
  for (const [site, field] of LANGS) {
    const html = await fetchPage(site, page);
    const names = parseNames(html, kind);
    // FORK: 색인의 itemname 링크 일부는 data-hover 가 해시 캐시(/cache/<lang>/…)라
    // 내부 ID 가 없다(2026-08 기준 ko/Items 4281건 중 743건). parseNames 가 통째로
    // 놓치므로, 그런 항목은 href 의 영문 슬러그로 잡는다. ko 보충 전용.
    const byHref = field === "ko" ? parseNamesByHref(html) : null;
    let filled = 0;
    let missing = 0;
    for (const entry of catalog) {
      const name =
        names.get(entry.id) ??
        (byHref && entry.name && entry.name !== "-" && entry.name !== entry.id
          ? byHref.get(slugify(entry.name))
          : undefined);
      if (!name) {
        // en 欄位是 `name`,一定存在;其他語言缺了就維持原值(fallback 英文)。
        if (field !== "en" && !entry[field]) missing++;
        continue;
      }
      if (field === "en") {
        // 既有的 en 名稱只在空白/佔位時補,避免覆蓋人工修正過的條目。
        if (!entry.name || entry.name === "-") {
          entry.name = name;
          filled++;
        }
      } else if (field === "ko") {
        // FORK: 佔位字串은 쓰지 않는다(화면에 "ko_Text" 가 그대로 나오는 걸 막는다).
        if (isPlaceholder(name)) missing++;
        else if (entry.ko !== name) {
          if (!entry.ko) filled++;
          entry.ko = name;
        }
      } else if (entry[field] !== name) {
        if (!entry[field] || entry[field] === "-") filled++;
        entry[field] = name;
      }
    }
    stats[field] = { filled, missing };
  }
  // 欄位順序固定(id, name, icon, zh, "zh-CN", zhCN, ja, ko),diff 才好讀。
  const ordered = catalog.map(
    ({ id, name, icon, zh, "zh-CN": reviewed, zhCN, ja, ko, ...rest }) => ({
      id,
      name,
      ...(icon ? { icon } : {}),
      ...(zh ? { zh } : {}),
      ...(reviewed ? { "zh-CN": reviewed } : {}),
      ...(zhCN ? { zhCN } : {}),
      ...(ja ? { ja } : {}),
      ...(ko ? { ko } : {}),
      ...rest,
    }),
  );
  await writeFile(path.join(DATA_DIR, file), JSON.stringify(ordered) + "\n");
  console.log(`${file}: ${catalog.length} entries`, stats);
}

if (shouldUpdate("items")) await updateCatalog("items.json", "Items", "Items");
if (shouldUpdate("pals")) await updateCatalog("pals.json", "Pals", "Pals");
if (shouldUpdate("technologies")) await updateTechnologies();
