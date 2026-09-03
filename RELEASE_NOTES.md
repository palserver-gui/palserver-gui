# palserver GUI — v2.10.0

修好「封鎖了玩家卻還是能進來」:Palworld 其實有兩套彼此獨立的封鎖名單(遊戲本體的 banlist.txt 與 PalDefender 的 Banlist.json),現在封鎖會兩邊一起寫、名單卡合併顯示並標來源,PalDefender 拒絕指令時也會照實報錯而不是顯示「已封鎖」。新增 Steam Workshop 模組管理(官方 1.0 模組系統的初版支援)與啟動參數自訂欄;大世界的存檔/備份不再因 5 秒逾時失敗。
Fixes "banned the player, but they can still join": Palworld actually keeps two independent ban lists (the game's own banlist.txt and PalDefender's Banlist.json). Bans now write to both, the ban list card merges them with a source tag, and a rejected PalDefender command is reported instead of showing "banned". Also adds Steam Workshop mod management (first cut for the official 1.0 mod system) and custom launch arguments; saving/backing up a large world no longer fails on a 5-second timeout.
「BAN したのにまだ参加できる」を修正:Palworld には独立した 2 つの BAN リスト(ゲーム本体の banlist.txt と PalDefender の Banlist.json)があり、BAN は両方に書き込み、リストカードは統合して出所を表示、PalDefender がコマンドを拒否した場合は「BAN 済み」ではなくエラーを表示するようにしました。Steam Workshop MOD 管理(公式 1.0 MOD システムの初期対応)と起動引数の自由入力欄を追加。大きなワールドのセーブ/バックアップが 5 秒タイムアウトで失敗しなくなりました。

> 有開自動更新會自己抓,或依下方手動下載。
> The in-app updater fetches it automatically, or download below.
> 自動更新で取得、または下記から手動でダウンロード。

<details open>
<summary><b>🇹🇼 繁體中文</b></summary>

### 新功能
- **Steam Workshop 模組管理(第一階段,issue #76)**:官方 1.0 模組系統把模組放在 `Mods/Workshop/<資料夾>/Info.json`、用 `Mods/PalModSettings.ini` 開關。模組分頁新增 Workshop 卡片:列出已放進去的模組(名稱、PackageName、版本、作者)、總開關 `bGlobalEnableMod`、每個模組的啟用開關、ini 裡有列但資料夾已不在的孤兒項目可一鍵移除、非伺服器模組會警示、一鍵開啟 Workshop 資料夾。只動 ini 的兩種鍵,其餘行與換行格式原樣保留。**僅支援 Windows 專用伺服器(含 Wine)**,這是初版、尚未在大量實機上驗過,遇到目錄位置判斷錯誤請回報。貼 Workshop ID 直接下載是下一階段。
- **啟動參數**:新增 `-enable-gamedata-api` 開關(官方 v1.0.3 起的 `GET /game-data`),以及「額外啟動參數」自由文字欄 —— 之後遊戲出了新旗標不必等 GUI 改版,直接填進去就會原樣附加到啟動指令(native / Docker / k8s 三種後端都會帶)。

### 修正
- **封鎖玩家後對方還是能加入**:Palworld 的封鎖名單有兩套、彼此獨立、連線時各自檢查 —— 遊戲本體的 `Pal/Saved/SaveGames/banlist.txt`(官方 REST `/ban` 寫這裡)與 PalDefender 的 `Banlist.json`(只有它的 RCON `ban` 會寫)。之前線上玩家的「封鎖」只寫前者、頁面下方的「封鎖名單」只讀後者,封了之後名單是空的、看起來像沒生效;而 PalDefender 回「Player not found」這類失敗文字時,GUI 也照樣顯示「已封鎖」。現在:
  - 封鎖與解除都**兩套一起寫**(裝了 PalDefender 才寫它那套),任一套成功即算成功,之後會回頭讀 `banlist.txt` 確認 ID 真的落地;某一邊沒寫進去或檔案裡沒看到 ID,會用黃色警示講清楚是哪一邊。
  - 封鎖名單卡**合併兩套名單**並標來源(官方名單 / PalDefender / 兩套名單);沒裝 PalDefender 也看得到官方名單、也能在離線玩家名冊直接封鎖與解除。
  - PalDefender 的 RCON 指令回應會被檢查,拒絕就報錯,不再靜默成功。
- **大世界的存檔/備份因 5 秒逾時而失敗**:REST `/save`、`/shutdown` 改用 60 秒逾時(一般輪詢維持 5 秒),逾時與連不上分開報錯;存檔改為 RCON `Save` 優先(不佔用 REST 輪詢)、失敗再走 REST;同一台伺服器同時發起的存檔請求(排程備份、手動備份、健康掃描、重啟)共用同一次,不再互搶。備份打包排除遊戲自己的 `backup/`、`world_save_bak`、`*.bak`,避免打包途中檔案被伺服器改寫而失敗。排程備份「未先存檔」的訊息改顯示實際原因(RCON/REST 逾時或未啟用),不再一律寫「REST API 未啟用」。

</details>

<details>
<summary><b>🇨🇳 简体中文</b></summary>

### 新功能
- **Steam 创意工坊模组管理(第一阶段,issue #76)**:官方 1.0 模组系统把模组放在 `Mods/Workshop/<文件夹>/Info.json`、用 `Mods/PalModSettings.ini` 开关。模组页新增创意工坊卡片:列出已放进去的模组(名称、PackageName、版本、作者)、总开关 `bGlobalEnableMod`、每个模组的启用开关、ini 里有列但文件夹已不在的孤儿项目可一键移除、非服务器模组会警示、一键打开 Workshop 文件夹。只改 ini 的两种键,其余行与换行格式原样保留。**仅支持 Windows 专用服务器(含 Wine)**,这是首版、尚未在大量实机上验证,遇到目录位置判断错误请反馈。粘贴创意工坊 ID 直接下载是下一阶段。
- **启动参数**:新增 `-enable-gamedata-api` 开关(官方 v1.0.3 起的 `GET /game-data`),以及「额外启动参数」自由文本栏 —— 之后游戏出了新旗标不必等 GUI 更新,直接填进去就会原样附加到启动命令(native / Docker / k8s 三种后端都会带)。

### 修正
- **封禁玩家后对方还是能加入**:Palworld 的封禁名单有两套、彼此独立、连接时各自检查 —— 游戏本体的 `Pal/Saved/SaveGames/banlist.txt`(官方 REST `/ban` 写这里)与 PalDefender 的 `Banlist.json`(只有它的 RCON `ban` 会写)。之前在线玩家的「封禁」只写前者、页面下方的「封禁名单」只读后者,封了之后名单是空的、看起来像没生效;而 PalDefender 返回「Player not found」这类失败文字时,GUI 也照样显示「已封禁」。现在:
  - 封禁与解除都**两套一起写**(装了 PalDefender 才写它那套),任一套成功即算成功,之后会回头读 `banlist.txt` 确认 ID 真的落地;某一边没写进去或文件里没看到 ID,会用黄色警示说明是哪一边。
  - 封禁名单卡**合并两套名单**并标注来源(官方名单 / PalDefender / 两套名单);没装 PalDefender 也看得到官方名单、也能在离线玩家名册直接封禁与解除。
  - PalDefender 的 RCON 指令响应会被检查,拒绝就报错,不再静默成功。
- **大世界的存档/备份因 5 秒超时而失败**:REST `/save`、`/shutdown` 改用 60 秒超时(一般轮询维持 5 秒),超时与连不上分开报错;存档改为 RCON `Save` 优先(不占用 REST 轮询)、失败再走 REST;同一台服务器同时发起的存档请求(计划备份、手动备份、健康扫描、重启)共用同一次,不再互抢。备份打包排除游戏自己的 `backup/`、`world_save_bak`、`*.bak`,避免打包途中文件被服务器改写而失败。计划备份「未先存档」的信息改显示实际原因(RCON/REST 超时或未启用),不再一律写「REST API 未启用」。

</details>

<details>
<summary><b>🇺🇸 English</b></summary>

### New
- **Steam Workshop mod management (first stage, issue #76)**: the official 1.0 mod system keeps mods under `Mods/Workshop/<folder>/Info.json` and toggles them via `Mods/PalModSettings.ini`. The Mods tab gains a Workshop card: lists the mods present (name, PackageName, version, author), the global `bGlobalEnableMod` switch, a per-mod toggle, one-click removal of orphaned ini entries whose folder is gone, a warning for non-server mods, and a button to open the Workshop folder. Only the two relevant ini keys are touched; every other line and the line-ending style are preserved. **Windows dedicated servers only (Wine included)** — this is a first cut that has not been exercised on many real machines yet, so please report if the folder location is detected wrong. Downloading by Workshop ID is the next stage.
- **Launch arguments**: a `-enable-gamedata-api` switch (the `GET /game-data` endpoint available since official v1.0.3) plus a free-text "extra launch arguments" field — when the game adds a new flag you can pass it straight through without waiting for a GUI release. Applies to all three backends (native / Docker / k8s).

### Fixes
- **Banned players could still join**: Palworld keeps two independent ban lists, each checked on connect — the game's own `Pal/Saved/SaveGames/banlist.txt` (written by the official REST `/ban`) and PalDefender's `Banlist.json` (written only by its RCON `ban`). The online-player "Ban" button wrote only the former while the "Ban list" card read only the latter, so the list looked empty after banning; and when PalDefender replied with failure text such as "Player not found", the GUI still showed "banned". Now:
  - Ban and unban **write to both lists** (PalDefender's only when it is installed); either succeeding counts as success, and the GUI reads `banlist.txt` back to confirm the ID actually landed. If one side failed or the ID is missing from the file, a yellow warning says which.
  - The ban list card **merges both lists** with a source tag (game list / PalDefender / both). Servers without PalDefender now see the game list too and can ban/unban straight from the offline roster.
  - PalDefender RCON replies are inspected; a rejection is reported instead of silently succeeding.
- **Saving/backing up a large world failed on a 5-second timeout**: REST `/save` and `/shutdown` now use a 60-second timeout (regular polling stays at 5 s), with timeouts reported separately from connection failures. Saving prefers RCON `Save` (keeps REST polling free) and falls back to REST; concurrent save requests on the same server (scheduled backup, manual backup, health scan, restart) share one save instead of racing. Backup archives exclude the game's own `backup/`, `world_save_bak` and `*.bak` so files rewritten mid-archive no longer abort the job. The scheduled-backup "could not save first" message now shows the real cause (RCON/REST timeout or disabled) instead of always blaming "REST API disabled".

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### 新機能
- **Steam Workshop MOD 管理(第 1 段階、issue #76)**:公式 1.0 MOD システムは MOD を `Mods/Workshop/<フォルダ>/Info.json` に置き、`Mods/PalModSettings.ini` で有効/無効を切り替えます。MOD タブに Workshop カードを追加:配置済み MOD の一覧(名前、PackageName、バージョン、作者)、全体スイッチ `bGlobalEnableMod`、MOD ごとの有効化スイッチ、ini に載っているがフォルダが無くなった孤立エントリのワンクリック削除、サーバー用でない MOD の警告、Workshop フォルダを開くボタン。ini は該当する 2 種類のキーだけを書き換え、他の行や改行形式はそのまま保持します。**Windows 専用サーバー(Wine 含む)のみ対応**。初版で実機での検証はまだ少ないため、フォルダ位置の判定が違う場合は報告してください。Workshop ID を貼って直接ダウンロードは次の段階です。
- **起動引数**:`-enable-gamedata-api` スイッチ(公式 v1.0.3 以降の `GET /game-data`)と「追加の起動引数」自由入力欄を追加 —— ゲームに新しいフラグが増えても GUI の更新を待たず、そのまま起動コマンドに付加できます(native / Docker / k8s の 3 バックエンドすべて対応)。

### 修正
- **BAN したプレイヤーがまだ参加できる**:Palworld には接続時にそれぞれ独立してチェックされる 2 つの BAN リストがあります —— ゲーム本体の `Pal/Saved/SaveGames/banlist.txt`(公式 REST `/ban` が書き込む)と PalDefender の `Banlist.json`(PalDefender の RCON `ban` だけが書き込む)。これまでオンラインプレイヤーの「BAN」は前者にしか書かず、ページ下部の「BAN リスト」は後者しか読まなかったため、BAN 後もリストが空で効いていないように見えました。さらに PalDefender が「Player not found」などの失敗文を返しても GUI は「BAN 済み」と表示していました。今回:
  - BAN と解除は**両方のリストに書き込み**(PalDefender 側はインストール時のみ)、どちらか成功すれば成功扱い。その後 `banlist.txt` を読み戻して ID が実際に記録されたか確認します。片側が失敗した、またはファイルに ID が無い場合は、どちら側かを黄色い警告で表示します。
  - BAN リストカードは**両方のリストを統合**し出所を表示(ゲーム本体 / PalDefender / 両方)。PalDefender 未導入でもゲーム本体のリストが見え、オフラインプレイヤー一覧から直接 BAN/解除できます。
  - PalDefender の RCON 応答を検査し、拒否された場合はエラーとして報告します。
- **大きなワールドのセーブ/バックアップが 5 秒タイムアウトで失敗**:REST `/save`、`/shutdown` は 60 秒タイムアウトに変更(通常のポーリングは 5 秒のまま)、タイムアウトと接続失敗を区別して報告。セーブは RCON `Save` を優先(REST ポーリングを占有しない)し、失敗時に REST へフォールバック。同じサーバーで同時に発生したセーブ要求(スケジュールバックアップ、手動バックアップ、ヘルススキャン、再起動)は 1 回にまとめて競合しません。バックアップのアーカイブからゲーム自身の `backup/`、`world_save_bak`、`*.bak` を除外し、アーカイブ中にサーバーが書き換えたファイルで失敗しなくなりました。スケジュールバックアップの「先にセーブできなかった」メッセージは実際の原因(RCON/REST のタイムアウトまたは無効)を表示します。

</details>
