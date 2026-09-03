# Steam Workshop 模組管理(issue #76)— 第一階段已做,待 Windows 實機驗證

寫於 2026-09-03。官方文件:https://docs.palworldgame.com/settings-and-operation/mod/

## 已做(第一階段)
- agent `packages/agent/src/workshop-mods.ts`:掃 `Mods/Workshop/*/Info.json`、讀寫 `Mods/PalModSettings.ini`
  (`bGlobalEnableMod` 總開關、每模組一行 `ActiveModList=<PackageName>`)。僅 native + Windows(或 runtime=wine)。
- 端點:`GET /api/instances/:id/workshop-mods`、`POST …/workshop-mods/toggle {packageName,enabled}`、`POST …/workshop-mods/global {enabled}`。
- web `ModsTab.tsx` 的 `WorkshopModCard`(supported 才顯示):總開關、每模組開關、非伺服器模組警示(Info.json 沒 IsServer)、
  孤兒項目(ini 有列但資料夾不在)可關閉、「開啟 Workshop 資料夾」走 FileBrowserDialog。
- 測試:`npx tsx --test packages/agent/src/workshop-mods.test.ts packages/agent/src/workshop-mods.fs.test.ts`(15 條)。
- Mac 只能用 playwright route mock 實拍(scratchpad ws-shot.mjs 的作法:mock `/mods` 與 `/workshop-mods*`,
  並把 `palserver.hiddenTabs.<id>` 設 `[]` 讓「模組」分頁露出)。

## 待在 Windows 測試機確認(三個未知,程式碼已留彈性)
1. **Mods 目錄到底在哪**:官方說「與伺服器執行檔同層」;專案直接啟動 `Pal/Binaries/Win64` 的 shipping exe。
   `resolveModsDir()` 兩個候選(`Mods`、`Pal/Binaries/Win64/Mods`)看哪邊有 ini/Workshop 就用哪邊,都沒有用根目錄。
   → 啟動一次伺服器,看 `PalModSettings.ini` 被生成在哪,若是 Win64 那邊要把候選順序對調。
2. **ini 不存在時我們先建的檔,伺服器接不接受、關機會不會重寫**(Engine.ini 那套「store 為權威、啟動前合併」可能要沿用)。
3. **Paks 型 Workshop 模組被裝進 `Mods/ManagedMods/` 後,會不會在既有 pak 模組清單重複出現**(`pak-mods.ts` 只掃 Pal/Content/Paks,應該不會,但要看 ManagedMods 實際放哪)。

## 第二階段(未做)
- 貼 Workshop ID/URL 直接下載:專案已用 DepotDownloader 抓伺服器本體,它有 `-pubfile <id>` 可抓 Workshop 項目,
  但 **Palworld 允不允許匿名帳號抓 Workshop 內容未證實**。先在 Windows 機實跑一次
  `DepotDownloader -app 1623730 -pubfile <id>`(匿名)決定做不做;不行就維持「使用者從客戶端 `steamapps/workshop/content/1623730/<id>` 複製」。
- `-workshopdir=` 自訂目錄:先用「額外啟動參數」欄位填,不另做 UI。
