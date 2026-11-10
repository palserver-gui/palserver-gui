#!/usr/bin/env bash
# ⚠ 已失效(2026-11 起):這支是 Zeabur 雲端(東京)時期的腳本,下面寫死的服務/環境 id 與
#   `npx zeabur service exec` 都已不存在,跑了只會失敗。服務現在在 Mac 上的自架 Zeabur
#   (namespace palserver-stats),整個 /data volume 每天 03:45(UTC+8)由叢集的 vol-daily
#   用 restic 備份到 Cloudflare R2(保留 7 個每日 + 4 個每週),見 README.md「備份與還原」。
#   要手動拉一份,照同樣步驟改用 `kubectl -n palserver-stats exec deploy/palserver-stats -- node -e …`。
#
# (原說明)把 Zeabur 上的 SQLite 拉回本機 data/(已 gitignore),並驗證完整性。
# 在容器裡先 VACUUM INTO 出一份一致的快照再 gzip;exec API 單次輸出到幾 MB 就會失敗,所以分段讀。
# 用法:bash backup.sh   (需已 `npx zeabur@latest auth login`)
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash:別把 /tmp 之類的參數改寫成 Windows 路徑

SVC=6ad99f3241d0e9b6bfde82c3
ENV=6ad99f23ce885214830bf3cc
CHUNK=999999 # 3 的倍數:每段 base64 都不帶中間 padding
cd "$(dirname "$0")"

zexec() { npx -y zeabur@latest service exec --id "$SVC" --env-id "$ENV" -i=false -- node -e "$1" "${@:2}" 2>/dev/null; }

# exec 的指令參數不能換行(多行會被吃掉、沒有任何輸出),node -e 的程式碼一律寫成單行。
size=$(zexec 'const {DatabaseSync}=require("node:sqlite");const fs=require("fs"),zlib=require("zlib");const t="/tmp/backup.sqlite";fs.rmSync(t,{force:true});new DatabaseSync(process.env.DB_PATH).prepare("VACUUM INTO ?").run(t);const gz=zlib.gzipSync(fs.readFileSync(t));fs.writeFileSync(t+".gz",gz);fs.rmSync(t);process.stdout.write(String(gz.length))')
[[ "$size" =~ ^[0-9]+$ ]] || { echo "快照失敗:$size" >&2; exit 1; }

mkdir -p data
out="data/zeabur-backup-$(date +%Y%m%d-%H%M%S).sqlite"
: > "$out.gz"
for ((off = 0; off < size; off += CHUNK)); do
  zexec 'const b=require("fs").readFileSync("/tmp/backup.sqlite.gz");process.stdout.write(b.subarray(+process.argv[1],+process.argv[1]+ +process.argv[2]).toString("base64"))' "$off" "$CHUNK" |
    tr -d '\r\n' | base64 -d >> "$out.gz"
done
zexec 'require("fs").rmSync("/tmp/backup.sqlite.gz",{force:true})' > /dev/null || true

[ "$(wc -c < "$out.gz")" -eq "$size" ] || { echo "下載大小不符($(wc -c < "$out.gz") / $size)" >&2; exit 1; }
gunzip "$out.gz"
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});
const n=(t)=>d.prepare("SELECT COUNT(*) n FROM "+t).get().n;
console.log("integrity",d.prepare("PRAGMA integrity_check").get().integrity_check,
  "| licenses",n("licenses"),"installs",n("installs"),"players",n("players"),"map_shares",n("map_shares"))' "$out" 2>/dev/null
echo "已備份到 packages/stats/$out"
