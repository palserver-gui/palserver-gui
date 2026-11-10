/**
 * Node HTTP 入口:開 SQLite 檔、套 schema,把每個請求轉成 Web Request 交給 index.ts。
 *
 * 環境變數:
 *   PORT         監聽埠,預設 8080
 *   DB_PATH      SQLite 檔,預設 /data/stats.sqlite(Zeabur 上 /data 掛 volume)
 *   RESTORE_URL  一次性搬家用:DB 檔還不存在時,先下載這個 SQL dump 匯入
 *                (`wrangler d1 export` 給的一小時效預簽網址)。匯入完就可以拿掉。
 *   其餘(ADMIN_TOKEN、AFDIAN_*、BREVO_* …)見 index.ts 的 Env。
 */

import { createServer, type IncomingMessage } from "node:http";
import { BlockList, isIP, isIPv6 } from "node:net";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db } from "./db.ts";
import app, { type Env } from "./index.ts";

const PORT = Number(process.env.PORT) || 8080;
const DB_PATH = process.env.DB_PATH ?? "/data/stats.sqlite";
/** 單一請求 body 上限:地圖快照 128 KiB 是最大的合法 body,1 MiB 綽綽有餘。 */
const MAX_BODY_BYTES = 1024 * 1024;

async function restoreFromDump(url: string) {
  console.log("[stats] DB 不存在,從 RESTORE_URL 匯入 D1 dump…");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載 dump 失敗:HTTP ${res.status}`);
  const sql = await res.text();
  // 先寫到暫存檔,整包匯入成功才改名,避免匯到一半當機留下殘缺的 DB。
  const tmp = DB_PATH + ".restoring";
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  db.exec("BEGIN;\n" + sql + "\nCOMMIT;");
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM licenses").get() as { n: number };
  db.close();
  renameSync(tmp, DB_PATH);
  console.log(`[stats] 匯入完成(licenses ${n} 筆)`);
}

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  // schema.sql 全是 IF NOT EXISTS,每次開機套一次即可(新建 DB 就是建表,舊 DB 是 no-op)。
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return db;
}

/** 內網位址(私有網段與本機)。Tunnel 進來的請求,前一站是叢集裡的 cloudflared,落在這些網段。 */
const INTERNAL = new BlockList();
for (const [addr, bits] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8]] as const) {
  INTERNAL.addSubnet(addr, bits, "ipv4");
}
INTERNAL.addSubnet("fc00::", 7, "ipv6");
INTERNAL.addAddress("::1", "ipv6");
const plainIp = (ip: string) => ip.replace(/^::ffff:(?=\d+\.)/, "");
const isInternal = (ip: string) => isIP(ip) > 0 && INTERNAL.check(ip, isIPv6(ip) ? "ipv6" : "ipv4");

/** 來源 IP(只給節流用)。入口代理會把前一站附加在 X-Forwarded-For 最後一段,前面幾段客戶端能偽造,所以只信最後一段。
 *  請求經 Cloudflare Tunnel 進來時,最後一段是叢集內 cloudflared 的位址,真正的訪客在 CF-Connecting-IP;
 *  只有前一站是內網位址時才採用它,從外部直接連進來的人自己加的不算。 */
function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const last = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").pop()?.trim();
  const peer = plainIp(last || req.socket.remoteAddress || "");
  const raw = req.headers["cf-connecting-ip"];
  const cf = plainIp((Array.isArray(raw) ? raw[0] : raw ?? "").trim());
  if (isIP(cf) > 0 && isInternal(peer)) return cf;
  return peer || "unknown";
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

mkdirSync(dirname(DB_PATH), { recursive: true });
if (!existsSync(DB_PATH) && process.env.RESTORE_URL) await restoreFromDump(process.env.RESTORE_URL);
const sqlite = openDatabase();

const env: Env = {
  DB: new Db(sqlite),
  // 以下三個預設值沿用 Worker 時代 wrangler.toml 的 [vars]。
  GITHUB_REPO: process.env.GITHUB_REPO ?? "io-software-ai/palserver-gui",
  AFDIAN_PLAN_IDS: process.env.AFDIAN_PLAN_IDS ?? "bd3bee5c838611f1bbe052540025c377",
  AFDIAN_API_BASE: process.env.AFDIAN_API_BASE ?? "https://ifdian.net",
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  BMC_WEBHOOK_SECRET: process.env.BMC_WEBHOOK_SECRET,
  AFDIAN_USER_ID: process.env.AFDIAN_USER_ID,
  AFDIAN_TOKEN: process.env.AFDIAN_TOKEN,
  BREVO_API_KEY: process.env.BREVO_API_KEY,
  BREVO_FROM_EMAIL: process.env.BREVO_FROM_EMAIL,
  BREVO_FROM_NAME: process.env.BREVO_FROM_NAME,
};

const server = createServer(async (req, res) => {
  try {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    if (body === null) {
      res.writeHead(413, { "Content-Type": "application/json" }).end('{"error":"body too large"}');
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    headers.set("X-Client-IP", clientIp(req));
    // 路由只看 pathname / searchParams,固定 base 免得被亂塞的 Host 標頭弄壞 URL 解析。
    const request = new Request(new URL(req.url ?? "/", "http://stats.local"), {
      method: req.method,
      headers,
      body: body?.length ? body : undefined,
    });
    const response = await app.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error("[stats] 未處理的錯誤:", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end('{"error":"internal"}');
  }
});

server.listen(PORT, () => console.log(`[stats] listening on :${PORT}, db=${DB_PATH}`));

// 收到停機訊號時收尾:關掉 DB 讓 WAL 寫回主檔。
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close();
    sqlite.close();
    process.exit(0);
  });
}
