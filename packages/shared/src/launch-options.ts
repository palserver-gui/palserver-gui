/**
 * Palworld 專用伺服器的命令列啟動參數(launch options)。
 *
 * 這些是「啟動時帶的命令列旗標」,跟 PalWorldSettings.ini(WORLD_OPTIONS)、
 * Engine.ini(ENGINE_OPTIONS)都不同。只收錄「不與 ini 重複」且官方文件明載的:
 * 效能/多執行緒旗標歸「引擎微調」,一般連線旗標歸「設定」。與 ini 重複的
 * (-players=ServerPlayerMaxNum、-publicip=PublicIP、-publicport=PublicPort、
 * -port=遊戲埠)刻意不收。queryPort 另以實例的第一級欄位處理(可編輯)。
 *
 * 來源:docs.palworldgame.com/settings-and-operation/arguments/
 * 注意:三個多執行緒旗標官方註記「v1.0 之後不設定反而可能更快」——非必開。
 */

export type LaunchOptionCategory = "perf" | "general";

export interface LaunchOptionMeta {
  /** 命令列旗標名(不含前導 -)。 */
  arg: string;
  type: "bool" | "int" | "enum" | "text";
  /** 值缺省(未設定)時的行為。 */
  default: boolean | number | string;
  category: LaunchOptionCategory;
  label: string;
  hint?: string;
  warn?: string;
  min?: number;
  max?: number;
  choices?: readonly string[];
}

export const LAUNCH_OPTIONS = {
  useperfthreads: {
    arg: "useperfthreads", type: "bool", default: false, category: "perf",
    label: "useperfthreads(效能執行緒)",
    warn: "官方註記:v1.0 之後不設定這三個多執行緒旗標,反而可能效能更好——非必開,建議實測比較。",
  },
  NoAsyncLoadingThread: {
    arg: "NoAsyncLoadingThread", type: "bool", default: false, category: "perf",
    label: "NoAsyncLoadingThread(停用非同步載入執行緒)",
  },
  UseMultithreadForDS: {
    arg: "UseMultithreadForDS", type: "bool", default: false, category: "perf",
    label: "UseMultithreadForDS(伺服器多執行緒)",
  },
  NumberOfWorkerThreadsServer: {
    arg: "NumberOfWorkerThreadsServer", type: "int", default: 0, min: 0, max: 128, category: "perf",
    label: "工作執行緒數(NumberOfWorkerThreadsServer)",
    hint: "0 = 不指定(交給系統)。需搭配上面的多執行緒旗標才有意義。",
  },
  publiclobby: {
    arg: "publiclobby", type: "bool", default: true, category: "general",
    label: "列為社群伺服器(publiclobby)",
    hint: "開啟後伺服器會出現在社群伺服器列表。",
  },
  logformat: {
    arg: "logformat", type: "enum", default: "text", choices: ["text", "json"], category: "general",
    label: "日誌格式(logformat)",
  },
  enableGamedataApi: {
    arg: "enable-gamedata-api", type: "bool", default: false, category: "general",
    label: "啟用遊戲資料 API(enable-gamedata-api)",
    hint: "v1.0.3 起官方提供的 GET /game-data 端點,走 REST API 埠;需同時開啟 REST API。",
  },
  extraArgs: {
    arg: "", type: "text", default: "", category: "general",
    label: "額外啟動參數",
    hint: "以空白分隔、原樣附加到啟動命令列,例如 -flagA -flagB=1。給上面沒列出的旗標用;請勿重複 -port / -queryport。",
  },
} as const satisfies Record<string, LaunchOptionMeta>;

export type LaunchOptionKey = keyof typeof LAUNCH_OPTIONS;
export type LaunchOptionValue = boolean | number | string;
export type LaunchOptions = Partial<Record<LaunchOptionKey, LaunchOptionValue>>;

export const LAUNCH_OPTION_KEYS = Object.keys(LAUNCH_OPTIONS) as LaunchOptionKey[];

export const LAUNCH_CATEGORY_LABELS: Record<LaunchOptionCategory, string> = {
  perf: "啟動參數(效能 / 多執行緒)",
  general: "啟動參數",
};

/** 把「額外啟動參數」文字切成 argv token(空白分隔、去空字串)。 */
export function splitExtraArgs(text: string): string[] {
  return text.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/** 由 launchOptions 組出命令列參數(不含 -port / -queryport,那兩個由呼叫端另外加)。 */
export function buildLaunchArgs(opts: LaunchOptions | undefined): string[] {
  const o = opts ?? {};
  const args: string[] = [];
  for (const key of LAUNCH_OPTION_KEYS) {
    const meta = LAUNCH_OPTIONS[key];
    const v = o[key] ?? meta.default;
    if (meta.type === "bool") {
      if (v === true) args.push(`-${meta.arg}`);
    } else if (meta.type === "int") {
      const n = Math.trunc(Number(v));
      if (Number.isFinite(n) && n > 0) args.push(`-${meta.arg}=${n}`);
    } else if (meta.type === "text") {
      // 自由文字:以空白切成獨立 argv token 原樣附加(不經 shell,無注入問題)。
      if (typeof v === "string") args.push(...splitExtraArgs(v));
    } else {
      // enum:只有和預設不同才帶(避免多餘參數)。
      if (typeof v === "string" && v && v !== meta.default) args.push(`-${meta.arg}=${v}`);
    }
  }
  return args;
}

/** Map launchOptions + queryPort to thijsvanloef image env vars (for k8s). */
export function buildLaunchEnv(
  opts: LaunchOptions | undefined,
  queryPort?: number,
): Record<string, string> {
  const o = opts ?? {};
  const env: Record<string, string> = {};
  const anyThreadFlag =
    o.useperfthreads === true ||
    o.UseMultithreadForDS === true ||
    o.NoAsyncLoadingThread === true;
  env.MULTITHREADING = anyThreadFlag ? "true" : "false";
  env.COMMUNITY = o.publiclobby === false ? "false" : "true";
  env.LOG_FORMAT_TYPE = String(o.logformat ?? "text");
  if (queryPort) env.QUERY_PORT = String(queryPort);
  return env;
}
