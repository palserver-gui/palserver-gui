#!/usr/bin/env node
/**
 * 抓「詞條(被動)」與「主動技」目錄,給指令台的自訂帕魯選單用。含 zh(繁中)/zhCN(上游簡中)/ja(日文)名稱;
 * 人工校對的 "zh-CN" 欄位只帶過不寫入(顯示時優先於 zhCN,見 docs/game-data-maintenance.md)。
 *
 * 資料來源(維護者為貢獻者,已獲同意;見 public/game-data/CREDITS.md):
 *  - 詞條(英文/rank):paldeck.cc/passives —— Next.js 串流資料裡有 {Asset(內部 id), Name, Rank}。
 *    Asset 就是 PalDefender Passives 陣列吃的內部 id。詞條沒有專屬圖示(遊戲內只有
 *    等級箭頭),所以只存 rank,前端自己畫箭頭。
 *  - 詞條 zh/zh-CN:paldb.cc/{en,tw,cn}/Passive_Skills 的「Pal Passive Skills」分頁卡片列表。
 *    這個列表**沒有**每筆專屬 id(不像主動技有 EPalWazaID),只能靠「en/tw 兩個語言版本
 *    卡片數量相同(114/114)且排列順序一致」用位置對應 —— 已用 rank 序列逐一核對過兩版
 *    完全相同,且是唯一未對到的英文名(paldb 少收錄 1.0 新詞條「Whopper」)。
 *    ja 版同一頁只收錄 102/114 筆(paldb 日文在地化進度落後,尚未跟上 1.0/屋久島新增
 *    內容),數量對不上代表位置對應會錯位,沒有安全的辦法重新對齊(內部 stat key、
 *    Weight 數值都會撞號),因此**詞條 ja 刻意留空**,不用猜的。
 *  - 主動技:名稱/zh/ja 都取自 paldb.cc/{en,tw,ja}/Active_Skills,anchor 帶
 *    `EPalWazaID::<id>`,三個語言版本用同一個內部 id 直接對接,不必靠位置猜測。
 *    元素取自 paldeck.cc/skills(waza_type -> element)。
 *
 * 產出:
 *  packages/web/public/game-data/passives.json      [{id,name,zh?,rank}]
 *  packages/web/public/game-data/activeSkills.json  [{id,name,zh?,ja?,element?}]
 *
 * 用法:node scripts/fetch-skills-passives.mjs
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "packages/web/public/game-data");
const UA = "palserver-gui-data-sync (maintainer-approved; github.com/io-software-ai/palserver-gui)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readExistingById(file) {
  try {
    const entries = JSON.parse(await readFile(path.join(DATA_DIR, file), "utf8"));
    return new Map(entries.map((entry) => [entry.id, entry]));
  } catch {
    return new Map();
  }
}

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

/** 依序抓一串 paldb.cc 網址,每次間隔一小段時間,別對同一個站狂發。 */
async function getSequential(urls) {
  const out = [];
  for (const url of urls) {
    if (out.length > 0) await sleep(400);
    out.push(await get(url));
  }
  return out;
}

/** paldb 未翻譯的欄位會吐佔位字串(例:"ko_Text"、"zh-Hant Text")—— 當成沒有名字。 */
const realName = (s) => (s && !/(^|[\s_-])Text$/.test(s) ? s : undefined);

/** 把 Next.js 頁面裡的 self.__next_f.push([n,"..."]) 片段解碼拼回完整字串。 */
function nextFlight(html) {
  let blob = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[\d+,\s*("(?:[^"\\]|\\.)*")\]\)/gs)) {
    try {
      blob += JSON.parse(m[1]);
    } catch {
      /* 略過壞片段 */
    }
  }
  return blob;
}

/** 詞條:從 paldeck 串流資料抓 Asset/Name/Rank。 */
function parsePassives(blob) {
  const out = [];
  const re = /\{"Asset":"([^"]+)","Name":"((?:[^"\\]|\\.)*)","Rank":(-?\d+)/g;
  for (const [, asset, rawName, rank] of blob.matchAll(re)) {
    const name = JSON.parse(`"${rawName}"`);
    out.push({ id: asset, name, rank: Number(rank) });
  }
  return out;
}

/** 主動技名稱:paldb 索引頁 EPalWazaID::<id> -> 名稱。 */
function parsePaldbWaza(html) {
  const names = new Map();
  const re =
    /data-hover="\?s=Waza%2FEPalWazaID%3A%3A([^"]+)"[^>]*>((?:[^<]|<(?!\/a>))*)<\/a>/g;
  for (const [, id, rawName] of html.matchAll(re)) {
    const name = rawName.replace(/<[^>]*>/g, "").trim();
    if (name && !names.has(id)) names.set(decodeURIComponent(id), name);
  }
  return names;
}

/** 主動技元素:paldeck 串流資料 waza_type -> element。 */
function parsePaldeckElements(blob) {
  const el = new Map();
  for (const [, id, element] of blob.matchAll(/"waza_type":"([^"]+)"[^}]*?"element":"([^"]+)"/g)) {
    el.set(id, element);
  }
  return el;
}

/**
 * 詞條 zh 對照:解析 paldb.cc/{lang}/Passive_Skills 的「Pal Passive Skills」卡片分頁,
 * 按頁面出現順序回傳 [{rank, name}, ...]。這個列表沒有專屬 id,呼叫端要靠位置對應
 * (只在兩個語言版本筆數相同時才安全,見檔頭註解)。
 */
function parsePaldbPassiveList(html) {
  const headerRe = /<h5 class="card-header">[^<]*\/\d+/g;
  const first = headerRe.exec(html);
  if (!first) return [];
  const second = headerRe.exec(html);
  const section = html.slice(first.index, second ? second.index : html.length);
  const out = [];
  for (const m of section.matchAll(/class="passive-rank(-?\d+) ps-2 py-1">([^<]*)<\/div>/g)) {
    out.push({ rank: Number(m[1]), name: m[2] });
  }
  return out;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const existingPassives = await readExistingById("passives.json");
  const existingSkills = await readExistingById("activeSkills.json");

  // ── 詞條(英文名 + rank,來源:paldeck) ──
  const passivesHtml = await get("https://paldeck.cc/passives");
  const passivesRaw = parsePassives(nextFlight(passivesHtml));
  // 去重(同 id 取第一筆),按 rank 高到低排。
  const seen = new Set();
  const passivesBase = [];
  for (const p of passivesRaw) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    passivesBase.push({ id: p.id, name: p.name, rank: p.rank });
  }

  // ── 詞條 zh(paldb en/tw 位置對應,見檔頭註解;ja 刻意留空) ──
  const [enPassiveHtml, twPassiveHtml, cnPassiveHtml, koPassiveHtml] = await getSequential([
    "https://paldb.cc/en/Passive_Skills",
    "https://paldb.cc/tw/Passive_Skills",
    "https://paldb.cc/cn/Passive_Skills",
    "https://paldb.cc/ko/Passive_Skills",
  ]);
  const enPassiveList = parsePaldbPassiveList(enPassiveHtml);
  const twPassiveList = parsePaldbPassiveList(twPassiveHtml);
  const cnPassiveList = parsePaldbPassiveList(cnPassiveHtml);
  const koPassiveList = parsePaldbPassiveList(koPassiveHtml);
  const enIndexByName = new Map();
  enPassiveList.forEach((e, i) => {
    if (!enIndexByName.has(e.name)) enIndexByName.set(e.name, i);
  });
  if (enPassiveList.length !== twPassiveList.length) {
    console.warn(
      `[警告] paldb en/tw 詞條卡片數量不一致(en ${enPassiveList.length} / tw ${twPassiveList.length}),位置對應可能不準,請人工複查。`,
    );
  }
  if (enPassiveList.length !== cnPassiveList.length) {
    console.warn(
      `[警告] paldb en/cn 詞條卡片數量不一致(en ${enPassiveList.length} / cn ${cnPassiveList.length}),位置對應可能不準,請人工複查。`,
    );
  }
  if (enPassiveList.length !== koPassiveList.length) {
    console.warn(
      `[警告] paldb en/ko 詞條卡片數量不一致(en ${enPassiveList.length} / ko ${koPassiveList.length}),位置對應可能不準,請人工複查。`,
    );
  }

  const passives = passivesBase.map((p) => {
    const idx = enIndexByName.get(p.name);
    const zh = idx !== undefined ? twPassiveList[idx]?.name : undefined;
    // 抓來的簡中進上游欄位 zhCN;人工校對的 "zh-CN" 原樣帶過,抓取腳本不寫入。
    const zhCN = (idx !== undefined ? cnPassiveList[idx]?.name : undefined) ?? existingPassives.get(p.id)?.zhCN;
    const reviewed = existingPassives.get(p.id)?.["zh-CN"];
    // FORK 추가: 한국어도 같은 위치 대응으로 가져온다(카드 수 일치는 위에서 경고로 검사).
    const ko = realName(idx !== undefined ? koPassiveList[idx]?.name : undefined) ?? existingPassives.get(p.id)?.ko;
    return {
      id: p.id,
      name: p.name,
      ...(zh ? { zh } : {}),
      ...(reviewed ? { "zh-CN": reviewed } : {}),
      ...(zhCN ? { zhCN } : {}),
      ...(ko ? { ko } : {}),
      rank: p.rank,
    };
  });
  passives.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  await writeFile(path.join(DATA_DIR, "passives.json"), JSON.stringify(passives) + "\n");

  // ── 主動技(名稱/zh/ja 都靠 EPalWazaID 內部 id 直接對接,不必猜位置) ──
  const [wazaHtmlEn, wazaHtmlZh, wazaHtmlZhCN, wazaHtmlJa, wazaHtmlKo, skillsHtml] = await getSequential([
    "https://paldb.cc/en/Active_Skills",
    "https://paldb.cc/tw/Active_Skills",
    "https://paldb.cc/cn/Active_Skills",
    "https://paldb.cc/ja/Active_Skills",
    "https://paldb.cc/ko/Active_Skills",
    "https://paldeck.cc/skills",
  ]);
  const namesEn = parsePaldbWaza(wazaHtmlEn);
  const namesZh = parsePaldbWaza(wazaHtmlZh);
  const namesZhCN = parsePaldbWaza(wazaHtmlZhCN);
  const namesJa = parsePaldbWaza(wazaHtmlJa);
  const namesKo = parsePaldbWaza(wazaHtmlKo);
  const elements = parsePaldeckElements(nextFlight(skillsHtml));
  const skills = [];
  const skillSeen = new Set();
  for (const [id, name] of namesEn) {
    if (skillSeen.has(id)) continue;
    skillSeen.add(id);
    const zh = namesZh.get(id);
    // 抓來的簡中進上游欄位 zhCN;人工校對的 "zh-CN" 原樣帶過,抓取腳本不寫入。
    const zhCN = namesZhCN.get(id) ?? existingSkills.get(id)?.zhCN;
    const reviewed = existingSkills.get(id)?.["zh-CN"];
    const ja = namesJa.get(id);
    // FORK 추가: 한국어명. paldb 영문 페이지에 이름이 없어 name 이 id 로 폴백되는 항목이
    // 57개 있는데(upstream 결손), 한국어 페이지에는 이름이 있는 경우가 많다.
    const ko = realName(namesKo.get(id)) ?? existingSkills.get(id)?.ko;
    const element = elements.get(id);
    skills.push({
      id,
      name,
      ...(zh ? { zh } : {}),
      ...(reviewed ? { "zh-CN": reviewed } : {}),
      ...(zhCN ? { zhCN } : {}),
      ...(ja ? { ja } : {}),
      ...(ko ? { ko } : {}),
      ...(element ? { element } : {}),
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(path.join(DATA_DIR, "activeSkills.json"), JSON.stringify(skills) + "\n");

  // ── 統計 ──
  const passiveZhCount = passives.filter((p) => p.zh).length;
  const passiveZhCNCount = passives.filter((p) => p.zhCN || p["zh-CN"]).length;
  const skillZhCount = skills.filter((s) => s.zh).length;
  const skillZhCNCount = skills.filter((s) => s.zhCN || s["zh-CN"]).length;
  const skillJaCount = skills.filter((s) => s.ja).length;
  console.log(
    `passives.json: ${passives.length} 條(zh ${passiveZhCount}/${passives.length};zh-CN ${passiveZhCNCount}/${passives.length};ja 未提供 —— paldb ja 頁詞條數量少於 en/tw,無法安全位置對應,見檔頭註解)`,
  );
  console.log(
    `activeSkills.json: ${skills.length} 條(有元素 ${skills.filter((s) => s.element).length};zh ${skillZhCount}/${skills.length};zh-CN ${skillZhCNCount}/${skills.length};ja ${skillJaCount}/${skills.length})`,
  );
}

await main();
