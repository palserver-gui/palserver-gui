import { useEffect, useState } from "react";
import { getLang } from "./i18n";
import { PREFER_KOREAN_GAME_NAMES } from "./flags";

/** Catalogs of Palworld entities, for labelling IDs and picking icons.
 * Served as static JSON from /game-data (see public/game-data/CREDITS.md).
 * 載入後會在背景比對 GitHub raw 上的最新版,名稱翻譯改了不用重新出版。 */
export interface GameEntity {
  id: string;
  /** English name (always present) */
  name: string;
  /** Traditional-Chinese name where known; extend the catalogs to add more */
  zh?: string;
  /** Simplified-Chinese name where known; generated from the reviewed Traditional-Chinese name */
  "zh-CN"?: string;
  /** Upstream Simplified-Chinese field; reviewed zh-CN takes precedence when both exist. */
  zhCN?: string;
  /** Japanese name where known(scripts/fetch-game-data-i18n.mjs 由 paldb.cc 抓) */
  ja?: string;
  /** FORK 추가: 한국어 이름(scripts/fetch-skills-passives.mjs 가 paldb.cc/ko 에서 수집) */
  ko?: string;
  /** icon filename within the category folder, or a path relative to /game-data */
  icon?: string;
  /** passive-skill rank (詞條 catalog only): 1–5 good, negative = 惡性 */
  rank?: number;
  /** element for active skills (主動技 catalog only), e.g. "Fire" */
  element?: string;
}

/** Preferred display name for the current UI language (fallback: English).
 *
 * FORK 추가: 이 앱에는 한국어 UI 로케일이 없어 getLang() 이 "ko" 를 돌려주는 일이 없다.
 * 그래서 PREFER_KOREAN_GAME_NAMES 가 켜져 있으면 UI 언어와 무관하게 게임 고유명사만
 * 한국어로 보여준다(버튼·라벨 등 UI 문자열은 기존 언어 그대로). 끄면 원래 동작. */
export const displayName = (e: GameEntity) => {
  if (PREFER_KOREAN_GAME_NAMES && e.ko) return e.ko;
  const lang = getLang();
  if (lang === "zh") return e.zh ?? e.name;
  if (lang === "zh-CN") return e["zh-CN"] ?? e.zhCN ?? e.zh ?? e.name;
  if (lang === "ja") return e.ja ?? e.name;
  return e.name;
};

export interface GameData {
  pals: GameEntity[];
  items: GameEntity[];
  /** 可由 learntech / unlearntech 使用的玩家科技目錄。 */
  technologies: GameEntity[];
  /** 帕魯蛋子集(items 中 id 以 PalEgg 開頭者),給「給予帕魯蛋」選單用,
   *  避免混入 Egg / FriedEggs 等食材。 */
  eggs: GameEntity[];
  /** 詞條(被動技)目錄,自訂帕魯用;id 為 PalDefender 內部 id */
  passives: GameEntity[];
  /** 主動技目錄,自訂帕魯用;id 為 EPalWazaID 去掉前綴 */
  activeSkills: GameEntity[];
  /** 人類 NPC 目錄(用帕魯球抓到的獵人/入侵者等,存檔的 CharacterID 也會指到這裡) */
  humans: GameEntity[];
  /** 公會研究目錄(Lab Research;id 為存檔 research_id) */
  research: GameEntity[];
  palById: Map<string, GameEntity>;
  itemById: Map<string, GameEntity>;
  passiveById: Map<string, GameEntity>;
  skillById: Map<string, GameEntity>;
  /** palById 的小寫鍵版本 —— 存檔的 CharacterID 大小寫不一定與圖鑑一致
   *  (實例:存檔 "Sheepball" vs 圖鑑 "SheepBall"),寬鬆查找用。 */
  palByIdLower: Map<string, GameEntity>;
  humanByIdLower: Map<string, GameEntity>;
  /** 研究 id → entity(含小寫鍵,查找寬鬆) */
  researchById: Map<string, GameEntity>;
}

export interface CharacterHit {
  entity: GameEntity;
  /** 完整圖示 URL(帕魯與人類 NPC 的圖檔在不同資料夾) */
  iconUrl?: string;
  /** true 表示這是合成回退實體（不在圖鑑中），用於 UI 標示提示 */
  unknown?: boolean;
}

/** 依存檔/REST 的 CharacterID 查「帕魯或人類 NPC」:
 *  大小寫寬鬆、BOSS_ 前綴自動剝除;帕魯圖鑑優先,再查人類 NPC 目錄。
 *  若完全找不到,會嘗試去尾綴(Boss001 等)後回退成自訂實體。 */
export function findCharacter(d: GameData | null, id: string): CharacterHit | undefined {
  if (!d || !id) return undefined;
  const bare = id.replace(/^BOSS_/i, "");
  const pal =
    d.palById.get(id) ??
    d.palById.get(bare) ??
    d.palByIdLower.get(id.toLowerCase()) ??
    d.palByIdLower.get(bare.toLowerCase());
  if (pal) return { entity: pal, iconUrl: pal.icon ? palIconUrl(pal.icon) : undefined };
  const human = d.humanByIdLower.get(id.toLowerCase()) ?? d.humanByIdLower.get(bare.toLowerCase());
  if (human) return { entity: human, iconUrl: human.icon ? humanIconUrl(human.icon) : undefined };
  // 目錄中找不到：剝除尾綴(如 YakushimaBoss001 → Yakushima)再試一次
  const cleaned = id.replace(/[Bb]oss\d*$/, "").replace(/\d+$/, "");
  if (cleaned && cleaned !== id) {
    const pal2 =
      d.palById.get(cleaned) ??
      d.palByIdLower.get(cleaned.toLowerCase());
    if (pal2) return { entity: pal2, iconUrl: pal2.icon ? palIconUrl(pal2.icon) : undefined, unknown: true };
    const human2 = d.humanByIdLower.get(cleaned.toLowerCase());
    if (human2) return { entity: human2, iconUrl: human2.icon ? humanIconUrl(human2.icon) : undefined, unknown: true };
  }
  // 真的找不到：回退成自訂實體，至少顯示一個可讀名稱
  const fallbackName = cleaned || id.replace(/_\d+$/, "");
  return {
    entity: { id, name: fallbackName },
    iconUrl: undefined,
    unknown: true,
  };
}

const REMOTE_BASE =
  "https://raw.githubusercontent.com/io-software-ai/palserver-gui/main/packages/web/public/game-data/";

let cache: GameData | null = null;
let inflight: Promise<GameData> | null = null;
const listeners = new Set<(d: GameData) => void>();

type Catalogs = [GameEntity[], GameEntity[], GameEntity[], GameEntity[], GameEntity[], GameEntity[], GameEntity[]];

function build([pals, items, passives, activeSkills, humans, research, technologies]: Catalogs): GameData {
  return {
    pals,
    items,
    technologies,
    eggs: items.filter((i) => i.id.startsWith("PalEgg")),
    passives,
    activeSkills,
    humans,
    research,
    palById: new Map(pals.map((p) => [p.id, p])),
    itemById: new Map(items.map((i) => [i.id, i])),
    passiveById: new Map(passives.map((p) => [p.id, p])),
    skillById: new Map(activeSkills.map((s) => [s.id, s])),
    palByIdLower: new Map(pals.map((p) => [p.id.toLowerCase(), p])),
    humanByIdLower: new Map(humans.map((h) => [h.id.toLowerCase(), h])),
    researchById: new Map(research.flatMap((r) => [[r.id, r], [r.id.toLowerCase(), r]])),
  };
}

function preserveSimplified(catalog: GameEntity[], fallback: GameEntity[]): GameEntity[] {
  const fallbackById = new Map(fallback.map((entry) => [entry.id, entry["zh-CN"]]));
  return catalog.map((entry) => {
    const reviewed = entry["zh-CN"] ?? fallbackById.get(entry.id);
    return reviewed ? { ...entry, "zh-CN": reviewed } : entry;
  });
}

async function fetchCatalogs(base: string, opts?: RequestInit): Promise<Catalogs> {
  const one = (file: string) =>
    fetch(`${base}${file}`, opts).then((r) => r.json() as Promise<GameEntity[]>);
  return Promise.all([
    one("pals.json"),
    one("items.json"),
    one("passives.json"),
    one("activeSkills.json"),
    // humans/research 較晚加入:遠端(GitHub raw)或舊快取拿不到時退空陣列,不擋整包
    one("humans.json").catch(() => [] as GameEntity[]),
    one("research.json").catch(() => [] as GameEntity[]),
    one("technologies.json").catch(() => [] as GameEntity[]),
  ]);
}

async function load(): Promise<GameData> {
  if (cache) return cache;
  if (!inflight) {
    inflight = (async () => {
      cache = build(await fetchCatalogs("/game-data/"));
      void refreshFromRemote();
      return cache;
    })();
  }
  return inflight;
}

/** 背景抓 GitHub 上的最新目錄,跟 bundled 版不同就換上(本 session 一次)。 */
let refreshed = false;
async function refreshFromRemote(): Promise<void> {
  if (refreshed) return;
  refreshed = true;
  try {
    const remote = await fetchCatalogs(REMOTE_BASE, {
      cache: "no-cache",
      signal: AbortSignal.timeout(15000),
    });
    // 遠端目錄缺 zh-CN 時,保留既有(bundled/人工校對)的簡中名稱,避免被空值蓋掉。
    // humans/research 抓失敗會退空陣列(fetchCatalogs 的 .catch):遠端拿到空、本地有料
    // 就保留本地,否則 pals/items 的合法更新會把它們連坐清空。
    const merge = (fetched: GameEntity[], cached: GameEntity[] | undefined): GameEntity[] =>
      fetched.length > 0 ? preserveSimplified(fetched, cached ?? []) : cached ?? [];
    const fresh: Catalogs = [
      merge(remote[0], cache?.pals),
      merge(remote[1], cache?.items),
      merge(remote[2], cache?.passives),
      merge(remote[3], cache?.activeSkills),
      merge(remote[4], cache?.humans),
      merge(remote[5], cache?.research),
      merge(remote[6], cache?.technologies),
    ];
    const [pals, items, passives, activeSkills, humans, research, technologies] = fresh;
    // 任一目錄跟目前載入的不同就換上 —— 舊版只比 pals/items,導致 humans/research
    // 這類後加的目錄在舊 bundle 上永遠不會被遠端更新補上
    const changed =
      JSON.stringify(pals) !== JSON.stringify(cache?.pals) ||
      JSON.stringify(items) !== JSON.stringify(cache?.items) ||
      JSON.stringify(passives) !== JSON.stringify(cache?.passives) ||
      JSON.stringify(activeSkills) !== JSON.stringify(cache?.activeSkills) ||
      JSON.stringify(humans) !== JSON.stringify(cache?.humans) ||
      JSON.stringify(research) !== JSON.stringify(cache?.research) ||
      JSON.stringify(technologies) !== JSON.stringify(cache?.technologies);
    if (Array.isArray(pals) && Array.isArray(items) && pals.length > 0 && items.length > 0 && changed) {
      cache = build(fresh);
      listeners.forEach((l) => l(cache!));
    }
  } catch {
    /* 離線或 GitHub 擋掉:用 bundled 版就好 */
  }
}

export function useGameData(): GameData | null {
  const [data, setData] = useState<GameData | null>(cache);
  useEffect(() => {
    listeners.add(setData);
    if (!cache) void load().then(setData).catch(() => setData(null));
    return () => {
      listeners.delete(setData);
    };
  }, []);
  return data;
}

export const palIconUrl = (icon: string) => `/game-data/pals/${icon}`;
export const itemIconUrl = (icon: string) => `/game-data/items/${icon}`;
export const technologyIconUrl = (icon: string) => `/game-data/${icon}`;
export const humanIconUrl = (icon: string) => `/game-data/humans/${icon}`;
