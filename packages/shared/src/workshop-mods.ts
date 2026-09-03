/**
 * Steam Workshop 模組(官方 1.0 模組系統)的共用型別。
 *
 * 官方機制(docs.palworldgame.com/settings-and-operation/mod/,2026-09-03 查證):
 * 只支援 Windows 專用伺服器;模組放 `Mods/Workshop/<任意資料夾>/Info.json`;
 * `Mods/PalModSettings.ini` 的 `bGlobalEnableMod` 是總開關、每個啟用的模組一行
 * `ActiveModList=<PackageName>`(PackageName 來自 Info.json,區分大小寫,不是資料夾名);
 * 只有 InstallRule 帶 `IsServer: true` 的模組在伺服器上有作用。
 */

export interface WorkshopMod {
  /** Mods/Workshop 底下的資料夾名。 */
  folder: string;
  /** Info.json 的 PackageName —— ActiveModList 用的鍵。 */
  packageName: string;
  name: string;
  version: string | null;
  author: string | null;
  /** Info.json 的 InstallRule 有任一條 IsServer:true。false 的模組在伺服器上不會做任何事。 */
  isServer: boolean;
  /** PalModSettings.ini 是否列在 ActiveModList。 */
  enabled: boolean;
}

export interface WorkshopModsStatus {
  supported: boolean;
  /** supported=false 時的原因(給 UI 顯示)。 */
  reason?: string;
  /** 相對於伺服器根目錄的 Workshop 目錄(給檔案管理開啟用),例 `Mods/Workshop`。 */
  workshopDir: string | null;
  /** PalModSettings.ini 是否存在(伺服器首次啟動後會自動生成;不存在時 agent 會在第一次寫入時建立)。 */
  iniExists: boolean;
  /** bGlobalEnableMod。 */
  globalEnabled: boolean;
  mods: WorkshopMod[];
  /** ActiveModList 裡有、但 Workshop 目錄找不到對應 Info.json 的 PackageName(可能是被刪掉的模組)。 */
  orphanActive: string[];
}
