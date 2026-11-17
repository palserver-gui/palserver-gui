import { WORLD_OPTIONS, type WorldSettings, type WorldOptionKey } from "@palserver/shared";

/**
 * Serialize structured settings into PalWorldSettings.ini.
 * Format: one OptionSettings=(Key=Value,...) tuple under the
 * [/Script/Pal.PalGameWorldSettings] section. Value formatting follows the
 * game's own DefaultPalWorldSettings.ini: floats get 6 decimals, enums are
 * emitted raw, free-form strings are double-quoted.
 */
export function renderPalWorldSettingsIni(settings: WorldSettings): string {
  const parts = (Object.keys(WORLD_OPTIONS) as WorldOptionKey[])
    .filter((key) => key in settings)
    .map((key) => {
      const meta = WORLD_OPTIONS[key];
      const value = settings[key];
      switch (meta.type) {
        case "bool":
          return `${key}=${value ? "True" : "False"}`;
        case "int":
          return `${key}=${Math.trunc(Number(value))}`;
        case "float":
          return `${key}=${Number(value).toFixed(6)}`;
        case "enum":
          return `${key}=${value}`;
        case "string":
          return `${key}=${JSON.stringify(String(value))}`;
      }
    });
  return [
    "[/Script/Pal.PalGameWorldSettings]",
    `OptionSettings=(${parts.join(",")})`,
    "",
  ].join("\n");
}

/**
 * Parse a PalWorldSettings.ini file back into a structured WorldSettings object.
 * Extracts Key=Value pairs from the OptionSettings=(...) tuple and coerces
 * each value to the correct type based on WORLD_OPTIONS metadata.
 */
export function parsePalWorldSettingsIni(ini: string): Partial<WorldSettings> {
  const m = /OptionSettings=\(([\s\S]*)\)/.exec(ini);
  if (!m) return {};
  const raw = m[1];
  const result: Record<string, unknown> = {};
  // Split on commas that are not inside quotes or parentheses
  const pairs = raw.match(/(\w+)=("[^"]*"|\([^)]*\)|[^,]+)/g) ?? [];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    let value: string = pair.slice(eq + 1).trim();
    // Unquote strings
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (!(key in WORLD_OPTIONS)) continue;
    const meta = WORLD_OPTIONS[key as WorldOptionKey];
    switch (meta.type) {
      case "bool":
        result[key] = value.toLowerCase() === "true";
        break;
      case "int":
        result[key] = Math.trunc(Number(value));
        break;
      case "float":
        result[key] = Number(value);
        break;
      case "enum":
      case "string":
        result[key] = value;
        break;
    }
  }
  return result as Partial<WorldSettings>;
}

/** 「伺服器這次開機時套用的設定」快照檔名(instanceDir 下),與 world-applied.json 並列。
 *  Palworld 關機時會把「開機時讀進記憶體的設定」寫回 PalWorldSettings.ini;
 *  有這份快照才分得出「遊戲寫回的開機值」與「使用者手動改的值」。 */
export const WORLD_BOOTED_FILE = "world-booted.json";

function parseSnapshot(raw: string | null): Record<string, unknown> | null {
  try {
    const j = raw === null ? null : (JSON.parse(raw) as unknown);
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 讀 ini 檔並與「agent 上次寫入的快照(JSON)」比對,回傳使用者手動改動的 patch。
 *  native 與 docker 共用(兩者的 ini/快照路徑不同,由呼叫端給)。
 *  沒有快照 = 首次/採用既有安裝 → 整份尊重現有檔案;ini 不存在 → 空 patch。
 *  bootedPath(選填)= 伺服器開機時套用的設定,用來排除遊戲關機時寫回的開機值。 */
export function diffIniAgainstSnapshot(
  readFileSync: (p: string) => string,
  iniPath: string,
  snapshotPath: string,
  bootedPath?: string,
): Partial<WorldSettings> {
  let iniRaw: string;
  try {
    iniRaw = readFileSync(iniPath);
  } catch {
    return {};
  }
  const readOptional = (p: string | undefined): string | null => {
    if (!p) return null;
    try {
      return readFileSync(p);
    } catch {
      return null; // 沒有快照
    }
  };
  return diffIniTextAgainstSnapshot(iniRaw, readOptional(snapshotPath), readOptional(bootedPath));
}

/** Same reconciliation for remote runtimes whose files are not host paths.
 *
 *  A key counts as a manual edit only when the ini value differs from what the agent
 *  last wrote (snapshot) AND from what the running server booted with (booted).
 *  Palworld rewrites PalWorldSettings.ini with its boot-time settings on shutdown, so
 *  without the second check a setting saved in the GUI while the server runs is
 *  reverted on the next restart (the write-back looks like a manual edit). */
export function diffIniTextAgainstSnapshot(
  iniRaw: string,
  snapshotRaw: string | null,
  bootedRaw: string | null = null,
): Partial<WorldSettings> {
  const fileSettings = parsePalWorldSettingsIni(iniRaw);
  const last = parseSnapshot(snapshotRaw);
  if (!last) return fileSettings;
  const booted = parseSnapshot(bootedRaw);
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fileSettings)) {
    if (last[k] === v) continue;
    if (booted && booted[k] === v) continue; // 遊戲關機寫回的開機值,不是手動編輯
    patch[k] = v;
  }
  return patch as Partial<WorldSettings>;
}
