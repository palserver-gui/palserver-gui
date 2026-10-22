# @palserver/stats — 匿名使用統計後端

Node + SQLite(部署在 Zeabur 東京),收集 palserver GUI 的匿名使用統計(隱私原則見根目錄
[PRIVACY.md](../../PRIVACY.md)),並彙總 GitHub Releases 下載數;同時負責贊助者識別碼與公開地圖快照。

> 2026-10 從 Cloudflare Worker + D1 搬過來。處理邏輯([src/index.ts](src/index.ts))沒變,
> [src/db.ts](src/db.ts) 是 node:sqlite 上的 D1 相容層,[src/server.ts](src/server.ts) 是 HTTP 入口。
> 舊 D1(`palserver-stats`)仍留在 Cloudflare 帳號裡當備份,`wrangler.toml` 只為了能再匯出它。

## 端點

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `POST` | `/api/event` | agent 回報事件:`hello`(啟動)、`instance_created`、`server_started`、`players_seen`(玩家雜湊批次) |
| `GET` | `/api/stats` | 公開彙總:`downloads` / `admins` / `players` / `instancesCreated` / `serverStarts` |
| `POST` | `/api/map/publish` | agent 每 60 秒推送地圖快照,見下方「公開地圖快照」 |
| `GET` | `/api/map/snapshot` | 公開讀取地圖快照(viewer 頁用) |
| `POST` | `/api/map/unpublish` | 服主下架地圖快照 |

## 部署(Zeabur)

| 項目 | 值 |
| --- | --- |
| 伺服器 | Ming's Server(騰訊雲 Tokyo,43.167.172.26) |
| Project | `palserver-stats`(`6ad99f2379815446417f79ce`) |
| Service | `palserver-stats`(`6ad99f3241d0e9b6bfde82c3`) |
| 網域 | `stats.iosoftware.ai`(正式)、`palserver-stats.zeabur.app` |
| Volume | `data` 掛在 `/data`;DB 檔 `/data/palserver-stats.sqlite`(環境變數 `DB_PATH`) |
| DNS | Cloudflare:`stats` A → `43.167.172.26`,**DNS only(灰雲)** |

> DNS 不能開 Cloudflare 代理(橘雲):節流用的來源 IP 取 Zeabur 入口附加在 `X-Forwarded-For` 的最後一段,
> 前面多一層代理就會變成 Cloudflare 節點的 IP。直連東京也是這次搬家的目的(中國線路連 Cloudflare 不穩)。

Dockerfile 建置,零執行期依賴(Node 24 內建 `node:sqlite`,直接跑 `.ts`)。開機時自動套
`schema.sql`(全是 `IF NOT EXISTS`),改 schema 後重新部署即可。

**重新部署**:`zeabur deploy` 會把整個目錄打包上傳,`data/`(DB 備份)與 `.env` 不能跟著上去,
所以從只含必要檔案的暫存目錄部署,且**一定要帶 `--service-id`**(不帶會多建一個新服務):

```bash
cd packages/stats
tmp=$(mktemp -d) && cp -r Dockerfile .dockerignore package.json schema.sql src "$tmp/" && cd "$tmp"
npx zeabur@latest deploy --project-id 6ad99f2379815446417f79ce --service-id 6ad99f3241d0e9b6bfde82c3 -i=false
```

本機開發:`DB_PATH=./data/stats.sqlite pnpm dev`(預設埠 8080)。

端點網址寫在 `packages/agent/src/env.ts`、`packages/web/src/stats.ts` 與官網;agent 端也可用環境變數
`PALSERVER_STATS_URL` 覆寫。

### 環境變數

在 Zeabur 服務的 Variables 設定(`npx zeabur@latest variable update --id <service-id> -k "K=V" -y -i=false`,
改完要 restart)。Git Bash 下設含 `/` 開頭的值要先 `export MSYS_NO_PATHCONV=1`,否則路徑會被改寫。

| 變數 | 用途 |
| --- | --- |
| `ADMIN_TOKEN` | 管理後台/發碼/解綁(本機副本在 `packages/stats/.env`,已 gitignore) |
| `DB_PATH` | SQLite 檔路徑 |
| `BMC_WEBHOOK_SECRET` | Buy Me a Coffee webhook 簽章密鑰 |
| `AFDIAN_USER_ID` / `AFDIAN_TOKEN` | 愛發電開發者頁的 user_id 與 API Token |
| `BREVO_API_KEY` | 寄贊助碼信 |
| `GITHUB_TOKEN` | 選填,GitHub 下載數 API 限流時用(fine-grained PAT,public repo 唯讀) |
| `GITHUB_REPO` / `AFDIAN_PLAN_IDS` / `AFDIAN_API_BASE` | 選填,預設值見 `src/server.ts` |
| `RESTORE_URL` | 只在搬家時用:DB 檔不存在時先下載這個 SQL dump 匯入,匯完即刪 |

### 備份與還原

```bash
pnpm db:backup   # = bash backup.sh:在容器裡 VACUUM INTO 快照 → gzip → 分段拉回 data/,驗 integrity 與筆數
```

搬家後沒有 D1 的 Time Travel 了,改 schema 或大動作前先跑一次。

還原/搬家:把 SQL dump 放到一個暫時可下載的網址,設 `RESTORE_URL` 並把 `DB_PATH` 指到一個還不存在的檔名,
restart 後服務會先匯入再開機(匯入到暫存檔、成功才改名,不會留下半套 DB)。

## 公開地圖快照

服主一鍵把伺服器地圖公開到全網:agent 每 60 秒把過濾後的地圖快照 JSON 推上來,
公開 viewer 頁(官網靜態頁)用 `id`(shareId)讀取。`id` 首次出現即註冊,綁定當下傳入的
`key`(只存 SHA-256 雜湊,不存明碼);之後同一個 `id` 要覆寫或下架都須帶對的 `key`。

- `POST /api/map/publish {id, key, snapshot}` — 註冊/更新快照;伺服器對伺服器端點(agent 直連),
  無 CORS(不帶 `Access-Control-Allow-Origin`)。`id` 需符合 `^[A-Za-z0-9_-]{8,32}$`;`snapshot`
  序列化後不得超過 128 KiB(413);同一 `id` 連續推送間隔須 ≥ 10 秒,否則 429;`key` 不符回
  401 `{error:"bad-key"}`。**新** `id`(第一次出現)另外受兩道防灌爆檢查:同一來源 IP(取
  `CF-Connecting-IP` 做 SHA-256,查不到當 `"unknown"`)24 小時內最多註冊 10 個新 id,超過回
  429 `{error:"rate-limited"}`;全站快照數 ≥ 50000 時回 503 `{error:"capacity"}`。新註冊路徑
  會順手清掉 48 小時前的節流紀錄,以及 60 天未更新(含已下架)的快照列。
- `GET /api/map/snapshot?id=...` — 公開讀取,`{updatedAt, snapshot}`,開放 CORS(`*`,含 OPTIONS
  preflight)、`Cache-Control: public, max-age=15`;找不到或已下架回 404。
- `POST /api/map/unpublish {id, key}` — 服主下架(伺服器對伺服器,無 CORS);`key` 不符 401,
  `id` 不存在 404。下架是「墓碑」(`revoked=1` + 清空 snapshot),不是刪列——之後任何人拿舊
  `key` 對同一個 `id` 重新 `publish` 一律回 410 `{error:"revoked"}`,不會被當成新 id 復活。

## 贊助者識別碼(先行版授權)

同一個服務也負責發/驗贊助者識別碼(一機一碼)。端點:

- `POST /api/license/activate {code, machineId}` — agent 用,驗證 + 首次綁機器(公開)
- `POST /api/license/issue {count?, trialDays?, expiresAt?, sponsor?, features?}` — 發碼(需 `X-Admin-Token`);`count` 可一次多張,`trialDays` = 啟用後 N 天(試用碼,兌換當下才起算到期)
- `POST /api/license/list {filter?, limit?}` — 列出識別碼(需 `X-Admin-Token`)
- `POST /api/license/reset {code}` — 解除綁定讓贊助者換機(需 `X-Admin-Token`)
- `POST /api/license/delete {code}` — 撤銷(刪除)一張碼(需 `X-Admin-Token`)
- `POST /api/license/bmc-webhook` — Buy Me a Coffee 月費會員 webhook(自動發碼/續期;信件依 BMC 語言中英日,fallback 英文)
- `POST /api/license/afdian-webhook` — 愛發電(Afdian/ifdian.net)訂單 webhook(自動發碼/依 month 續期;無簽章,靠 query-order 回查驗真)
- `GET  /api/license/afdian-redeem?out_trade_no=<訂單號>` — 愛發電自助查碼(公開;愛發電無 email,贊助者貼訂單號換碼)

### 管理後台 UI

`GET /admin`(`https://stats.iosoftware.ai/admin`)是一個發碼/管理的網頁介面:
輸入 `ADMIN_TOKEN` 後可**大量發試用碼**(數量、啟用後 N 天 / 固定到期 / 永久、活動標籤)、
複製 / 下載 CSV,並在表格裡檢視、解綁、撤銷。頁面公開但所有操作都要 Token,Token 只存在該分頁。

> 新增 `trial_days` 欄位:舊 DB 需 `ALTER TABLE licenses ADD COLUMN trial_days INTEGER;`(見 schema.sql)。

```bash
# 管理密鑰 = Zeabur 環境變數 ADMIN_TOKEN(本機副本在 .env)
# 手動發一張碼(帶 expiresAt 即為月費;到期後 agent 重驗會鎖上)
curl -X POST https://stats.iosoftware.ai/api/license/issue \
  -H "X-Admin-Token: <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{"sponsor":"某人","expiresAt":"2026-09-01"}'
```

### 接 Buy Me a Coffee 月費

1. BMC 開一個月費 **Membership** 方案。
2. BMC 後台 → Webhooks 新增,URL 填 `https://stats.iosoftware.ai/api/license/bmc-webhook`,複製**簽章密鑰**。
3. 在 Zeabur 設環境變數;Brevo(app.brevo.com)用來把碼 email 給贊助者(需先在 Brevo 驗證寄件者/網域):
   - `BMC_WEBHOOK_SECRET`:BMC 給的 webhook secret
   - `BREVO_API_KEY`:Brevo API key(SMTP & API → API Keys)
   - 選填 `BREVO_FROM_EMAIL` / `BREVO_FROM_NAME`(預設 palserver GUI <palserver-gui@iosoftware.ai>)

流程:會員 `membership.started` → 建碼並 email 給贊助者;`membership.updated`(續訂)→ 延長效期;
`cancelled` / `paused` → 不再續期,當期到期後停用。webhook 會先用 `x-signature-sha256`
(HMAC-SHA256)驗簽,沒設 `BMC_WEBHOOK_SECRET` 一律拒絕。

### 接愛發電(Afdian / ifdian.net)

愛發電跟 BMC 不同:**沒有自動扣款**(「包月」是預付多月或每月手動再贊助,每筆都獨立推一次
`type:order` webhook)、**webhook 沒有簽章**、**payload 沒有 email**。因此:發碼靠 webhook 用
`out_trade_no` 回打 **query-order API 驗真**(防偽造)後,依買家 `user_id` 認人、依 `month`
把**同一張碼**的效期往後累加(找不到才發新碼);交付走**自助查碼頁**(贊助者貼訂單號換碼)。

1. 愛發電開發者頁(`https://ifdian.net/dashboard/dev` 或 `afdian.com`):
   - **Webhook URL** 填 `https://stats.iosoftware.ai/api/license/afdian-webhook`(可按「發送測試」,我方一律回 `{"ec":200}`;
     測試用的是假訂單號,驗不過屬正常、不會發碼,顯示成功即代表端點通)。
   - 記下 **user_id**、按「生成 Token」拿 **API Token**。
2. 在 Zeabur 設環境變數 `AFDIAN_USER_ID`(開發者頁的 user_id)與 `AFDIAN_TOKEN`(開發者頁生成的 API Token)。
   `AFDIAN_PLAN_IDS`(只認的包月方案 plan_id,逗號分隔)與 `AFDIAN_API_BASE`(舊域 afdian.net 已停用)
   的預設值在 `src/server.ts`,目前是 ¥60/月方案與 `https://ifdian.net`。

3. 方案說明請引導贊助者:贊助後到 GUI **設定 → 贊助者識別碼 → 從愛發電領取識別碼**,貼上訂單號換碼
   (前端此入口只在 UI 語言切到**簡體中文**時顯示)。

> `AFDIAN_USER_ID` / `AFDIAN_TOKEN` 任一沒設,webhook 與 redeem 一律拒絕(不無驗證發碼)。
> query-order 回查路徑(webhook 驗真、redeem 未命中)有 per-IP 節流(60 次/小時),擋惡意刷爆 API 配額。

### 管理 CLI(`manage.mjs`)

BMC 後台那個「新增 webhook」要手動做(BMC 沒有建 webhook 的 API),其餘可用這支腳本:

```bash
# 環境變數放 packages/stats/.env(已被 gitignore):
#   WORKER_URL(= https://stats.iosoftware.ai)/ ADMIN_TOKEN / BMC_WEBHOOK_SECRET
pnpm license:test  -- membership.started you@example.com   # 送簽好章的假 webhook,驗整條線
pnpm license:issue -- "某贊助者" 2026-09-01                # 手動發一張碼(月費填到期日)
pnpm license:reset -- PAL-XXXX-XXXX-XXXX                    # 解綁,讓贊助者換機
```

## 之後改 schema

schema.sql 全部是 IF NOT EXISTS,服務每次開機都會套用,改完重新部署即可(見上方「部署」)。
既有表要加欄位得另外 ALTER(用 `zeabur service exec` 跑 node:sqlite),改之前先 `pnpm db:backup`。
