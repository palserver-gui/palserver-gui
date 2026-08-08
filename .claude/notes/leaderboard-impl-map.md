# 存檔掃描管線資料形狀與 web 掛載點 — 實作參考

寫於 2026-07-16。目的:給「伺服器排行榜 + 掃描間差異週報」與「玩家圖鑑收集完成度(贊助功能)」兩個新功能定位資料來源與 UI 掛點。搜尋廣度 medium,排除 node_modules / dist / deperated/。

相關既有筆記(未逐字複查,僅供交叉參考):`.claude/notes/save-slim-impl.md`(palsav 欄位路徑對照)、`.claude/notes/savetools-integration.md`。

---

## 1. agent 端掃描管線(save-tools.ts / save-health.ts)

檔案:`packages/agent/src/save-tools.ts`、`packages/agent/src/save-health.ts`

- **觸發**:`POST /api/instances/:id/saves/health` → `routes.ts:1584` → `startHealthCheck()`(`save-tools.ts:438`)。同一 instance 同時只能有一個 job(`jobs` Map,`save-tools.ts:157`),進行中再叫回 409(`save-tools.ts:441`)。平台不支援(k8s 後端 / 非 Windows-Linux x64)回 400(`saveHealthSupport()`,`save-tools.ts:53`)。
- **流程**(`runJob()`,`save-tools.ts:336`):
  1. `flushWorld(rec)` 請伺服器落盤(唯讀分析最近一次存檔)。
  2. 統計 `Level.sav` 大小/mtime、`Players/*.sav` 個數與總大小、世界目錄總大小。
  3. `ensurePalsav()` 下載/驗證外部工具 `palsav`(GitHub Release,SHA256 驗證,快取在 `DATA_DIR/tools/palsav-<tag>/`)。
  4. `buildContainerIndex()`(`save-tools.ts:293`)先解析 `Players/*.sav`(逐檔轉 JSON、上限 `MAX_PLAYER_SAVS=50`),建立兩份對照:容器 id → party/palbox(帕魯位置)、容器 id → {uid, 物品分類}(離線物品歸屬)。
  5. `runConvert()`(`save-tools.ts:234`)呼叫 `palsav convert --to-json` 把 `Level.sav` 轉成 JSON(子行程,逾時 30 分鐘)。
  6. `analyzeLevelJsonFile()`(`save-health.ts:839`,底層 `Analyzer` class `save-health.ts:157`)用 `stream-json` 逐 token 掃描,**不整棵 JSON.parse**(大型世界可能數 GB)。
  7. 公會倉庫內容是第二趟輕量掃描補的(`collectContainerContents()`,`save-health.ts:801`;呼叫點 `save-tools.ts:407-421`),因為倉庫容器 id 在存檔後段的 `GuildExtraSaveDataMap` 才出現。
- **產出兩份檔案**(`save-tools.ts:41-43`,落地在 `ctx.instanceDir` = `DATA_DIR/instances/<id>/`,`store.ts:181`):
  - `save-health.json`:`Record<worldGuid, SaveHealthReport>`,由 `writeReport()`(`save-tools.ts:178`)寫入 —— **讀出整份、覆蓋該 worldGuid 的 key、整份寫回**。
  - `save-players.json`:`Record<worldGuid, SavePlayersSnapshot>`,由 `writeSnapshot()`(`save-tools.ts:198`)寫入,同樣是**整份覆蓋**。
- **記憶體狀態**:`jobs`(進行中任務,`save-tools.ts:157`)與 `lastErrors`(`save-tools.ts:158`)只存在 process 記憶體,agent 重啟就清空;不影響已落地的報告/快照檔。
- **資料何時失效 / 何時重新產生**:沒有 TTL,`getPlayersSummary()` / `getGuildsSnapshot()` / `getPlayerProfile()` 都是直接讀 `save-players.json` 目前內容,直到下次 `startHealthCheck()` 覆蓋。舊快照缺欄位時個別欄位會是 `null`/`unknown`(見第 2 節)。

## 2. `GET /api/instances/:id/saves/players-snapshot` 回傳型別

路由:`packages/agent/src/routes.ts:1596-1612`。無 `uid` 查詢參數 → 回 `SavePlayersSummary & { worldGuid }`(不含 `pals` 明細);帶 `uid` → 回 `{ worldGuid, profile: SavePlayerProfile }`(含 `pals` 明細)。

型別定義:`packages/shared/src/index.ts`
- `SavePlayerProfile`(第 734-751 行):`uid, name, level, exp, guildName, lastOnlineDaysAgo, palCount, pals: SavePalRow[], inventory?: SavePlayerInventory|null, guild?: SavePlayerGuild|null, statusPoints?: {name,points}[], unusedStatusPoints?: number|null`。
- `SavePalRow`(第 674-694 行,每隻帕魯的欄位):`instanceId`(角色實例 id,可跨 PalDefender 對聯)、`characterId`(**species id**,`BOSS_` 前綴=首領)、`nickname?`、`level`、`gender`、`rank`(**星級**,0/1=未強化)、`isLucky`、`isBoss`、`talentHp/talentShot/talentDefense`(**個體值 IV**,0-100)、`passives: string[]`(**詞條**)、`location`("party"|"palbox"|"base"|"unknown")。
- `SavePlayerInventory`(第 702-715 行):`money, common, essential, weapons, armor, food`(各為 `SaveItemStack[] = {itemId, count}[]`)。
- `SavePlayerGuild`(第 725-732 行):`name, role("admin"|"member"), memberCount, baseCampLevel, bases: SaveGuildBase[]`。
- `SavePlayersSummary`(第 783-787 行):`generatedAt, levelSavMtime, players: Omit<SavePlayerProfile,"pals">[]`(玩家清單頁用,不帶帕魯明細)。
- 玩家「等級/金錢」欄位:等級在 `SavePlayerProfile.level`;金錢在 `SavePlayerProfile.inventory.money`(需先解析到容器,拿不到為 `null`)。

**圖鑑/捕捉紀錄欄位:players-snapshot 裡沒有。** 不存在 `PalCaptureCount`/`RecordData`/`PalDeck` 之類欄位,`SavePalRow`/`SavePlayerProfile` 都沒有。

解析層(`save-health.ts` 的 `Analyzer`)確認也**沒有讀到**:`SECTIONS` 常數(`save-health.ts:84-93`)只涵蓋 `CharacterSaveParameterMap / GroupSaveDataMap / ItemContainerSaveData / CharacterContainerSaveData / MapObjectSaveData / DynamicItemSaveData / BaseCampSaveData / GuildExtraSaveDataMap`,`scalar()` 的 `CharacterSaveParameterMap` case(`save-health.ts:482-540`)只挑 `NickName/CharacterID/OwnerPlayerUId/Level/Exp/Rank/Talent_*/IsRarePal/PassiveSkillList/GotStatusPointList` 等欄位 —— 玩家 SaveParameter 底下實際還有的 `RecordData`(存捕捉紀錄的結構)完全沒被讀取或丟棄,是「連讀都沒讀」而非「讀到沒輸出」。

**最接近的既有資料是另一條完全不同的管線**:PalDefender REST(`packages/agent/src/paldefender-rest.ts:398-428`,`fetchProgression()`)會呼叫 `/progression/{uid}`,其回應內有 `Progression.Captures.tribeCaptureCount`(捕捉過的**帕魯種類數**,非物種列表)與 `Captures.palCaptureCounts`(逐物種計數的物件,但目前程式碼只用 `Object.keys(...).length` 算數量,**沒有保留逐物種明細**,見 `paldefender-rest.ts:415,423`)。這份資料落在共享型別 `PlayerProgression.palsCaptured`(`packages/shared/src/index.ts:262-272`,欄位在 270-271 行),經 `PlayerDetail.progression`(同檔 233-252 行)回傳,只在**伺服器有裝 PalDefender 且啟用 REST + 有 token** 時可用,且離線玩家可能拿不到(`available` 判斷見 `paldefender-rest.ts:461-549`)。若要做「圖鑑收集完成度」,兩條路都不完整:save-scan 管線目前完全不解析捕捉紀錄(需要新增 `RecordData`/`PalCaptureCount` 的欄位擷取,擴充 `SavePlayerProfile`);PalDefender 路線只有聚合種類數、無逐物種清單且依賴 mod。

## 3. 公會快照 endpoint 與 shape

路由:`GET /api/instances/:id/saves/guilds-snapshot`(`routes.ts:1615-1623`),回傳 `{ worldGuid, generatedAt, guilds: SaveGuild[] }`(由 `getGuildsSnapshot()`,`save-tools.ts:216-222`,同樣讀 `save-players.json`)。

`SaveGuild` 型別(`packages/shared/src/index.ts:759-771`):
- `id, name, adminUid, baseCampLevel`
- `members: {uid, name, lastOnlineDaysAgo}[]`
- `bases: (SaveGuildBase & {workers: SaveGuildWorkerPal[]})[]`(`SaveGuildBase={id,name,x,y}`,`SaveGuildWorkerPal={characterId,level}` 即據點駐守帕魯的輕量索引)
- `storage: SaveItemStack[] | null`(二趟掃描補;拿不到為 `null`)
- `research: {currentId: string|null, entries: {id,workAmount}[]} | null`(公會研究進度)

Web 端消費:`packages/web/src/GuildsTab.tsx:39`(`client.guildsSnapshot(instanceId)`)、`packages/web/src/GuildDetailModal.tsx`(詳情彈窗)。

## 4. web 端掛點

- **`PlayerDetailModal.tsx`**(`packages/web/src/PlayerDetailModal.tsx`):
  - 資料來源:兩路合併,不分 tab —— PalDefender REST 即時資料(`client.playerDetail()`,第 67-77 行)與存檔快照(`client.playersSnapshot()` + `client.playerSnapshotProfile()`,`loadSnapshot()` 第 89-125 行)。

- **`SavesTab.tsx` / `HealthCard`**:沒有獨立 `HealthCard.tsx` 檔案,是 `SavesTab.tsx` 內的一個 function(第 259-460 行)。掃描觸發:`client.startSaveHealth()`(第 314 行)→ 2 秒輪詢 `client.saveHealth()`(第 291-309 行)直到 `phase==="idle"`。結果顯示:世界大小/玩家檔統計文字(第 410-418 行)、`HealthStat` 卡片格(玩家/帕魯/公會/物品容器/掉落物/動態物品,第 419-426 行)、可展開明細(不活躍玩家清單、空公會名單,第 428-452 行)。贊助鎖:`entitled` 同樣走 `hasFeature("save-slim", l)`(第 280 行),鎖住時顯示提示區塊(第 364-369 行)。
- **實例詳情分頁清單**:定義在 `packages/web/src/tabPrefs.ts`。`Tab` 型別(第 4-17 行)+ `TABS` 陣列(`{id, label}[]`,第 20-33 行,決定顯示順序與 i18n label)。`LOCKED_TABS = ["overview","instance"]`(不可隱藏)。加新分頁的方法:①在 `Tab` union 加新 id;②在 `TABS` 陣列加 `{id, label}`;③在 `packages/web/src/InstanceDetail.tsx` import 對應 Tab 元件並在 render 區塊加 `{tab === "xxx" && <XxxTab .../>}`(仿現有 `saves`/`palstats` 分支,約第 297-369 行);若要贊助鎖,分頁內容元件內部自行判斷 `hasFeature`(參考 `SavesTab`/`PlayerDetailModal` 寫法),不是在 `tabPrefs.ts` 鎖。

## 5. 贊助功能機制

- Feature id 清單:`packages/shared/src/features.ts:16-24`(`EARLY_ACCESS_FEATURES`)— 目前 8 個:`custom-pal, guild-map, pal-stats, bulk-items, teleport, log-tools, dashboard-stats, save-slim`。不在清單裡的功能一律免費(`featureFreeNow()`,第 27-29 行)。
- `hasFeature(id, lic)`(第 55-57 行):`featureFreeNow(id) || lic.valid` —— 單一贊助層級,有效授權解鎖全部清單內功能,無需在 `lic.features` 逐項比對。
- 兩個現成鎖 UI 範例:
  1. `packages/web/src/SavesTab.tsx:280`(`setEntitled(hasFeature("save-slim", l))`)+ 鎖住提示 `packages/web/src/SavesTab.tsx:364-369`(`FiLock` + 文字 + 指向「設定 → 贊助者識別碼」)。

- 新功能(排行榜週報 / 圖鑑收集度)若要贊助鎖,建議在 `features.ts` 的 `EARLY_ACCESS_FEATURES` 加新 id,再套用上述任一寫法。

## 6. 掃描結果有沒有持久化歷史

**沒有**。`save-tools.ts` 的 `writeReport()`(第 178-182 行)與 `writeSnapshot()`(第 198-202 行)都是「讀出整份 JSON → 用 `worldGuid` 當 key 覆蓋該筆 → 整份寫回」,即 `save-health.json` / `save-players.json` 內每個 `worldGuid` 只保留**最新一次**掃描結果,沒有陣列或時間序清單。多個世界(worldGuid 不同)會各自有一筆,但同一世界重新掃描就覆蓋舊資料,舊報告/快照拿不回來。

**這對「掃描間差異週報」的直接影響**:要做「這次掃描 vs 上次掃描」的差異,現有管線本身不提供歷史 —— 必須在 `writeReport`/`writeSnapshot` 覆蓋前自行把舊值另存(例如追加寫入新檔 `save-players-history.json` 或在覆蓋前把舊快照存一份到帶時間戳的 key),或另建獨立的歷史記錄機制。

---

## 待新增功能落點小結(供實作時參考,非驗收要求逐項)

- **伺服器排行榜**:可直接讀 `SavePlayersSummary.players`(`GET .../players-snapshot`,不含 pals 明細,夠算等級/公會排名)按 `level` 或未來加的欄位排序;UI 可放新分頁(`tabPrefs.ts` 加 `Tab`)或掛在既有 `PlayersTab.tsx`。
- **掃描間差異週報**:需要新增歷史保存(見第 6 節結論),agent 端在 `save-tools.ts` 的 `writeReport`/`writeSnapshot` 前後動手;或另開一支排程比較邏輯。

