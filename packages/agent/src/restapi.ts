import type {
  GameDataSnapshot,
  LiveStatus,
  RestMetrics,
  RestPlayer,
  RestServerInfo,
} from "@palserver/shared";
import type { InstanceRecord } from "./store.js";

/**
 * Thin proxy over the Palworld dedicated server's own REST API
 * (docs.palworldgame.com/api/rest-api). Basic auth with user "admin" and the
 * instance's AdminPassword. The game API stays bound to the agent's host and
 * is never exposed to the browser — the UI only ever talks to the agent.
 */

/** Polling calls (/info, /players, …) answer in milliseconds; a hung server
 * should be noticed quickly. */
const TIMEOUT_MS = 5000;
/** /save and /shutdown block until the world is flushed. A large world
 * (multi-hundred-MB Level.sav) takes 5–15 s, so these get their own budget —
 * with the 5 s default the request was aborted mid-save and reported as a
 * failure even though the server kept writing. */
export const SLOW_TIMEOUT_MS = 60_000;

class RestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

/** docker/native: REST API on 127.0.0.1:<RESTAPIPort>; k8s: ClusterIP Service
 * (<service>.<namespace>) reachable from the agent. All backends use
 * RESTAPIPort directly — docker binds container port = host port (1:1). */
async function baseUrl(rec: InstanceRecord): Promise<string> {
  if (rec.backend === "k8s" && rec.k8sServiceName && rec.k8sNamespace) {
    return `http://${rec.k8sServiceName}.${rec.k8sNamespace}:${rec.settings.RESTAPIPort}/v1/api`;
  }
  return `http://127.0.0.1:${rec.settings.RESTAPIPort}/v1/api`;
}

function requireRest(rec: InstanceRecord): void {
  if (!rec.settings.RESTAPIEnabled) {
    throw new RestError("REST API 未啟用 — 請到世界設定開啟 RESTAPIEnabled 並重啟", 409);
  }
  if (!rec.settings.AdminPassword) {
    throw new RestError("尚未設定管理員密碼 — 請到世界設定填入 AdminPassword 並重啟", 409);
  }
}

async function call<T>(
  rec: InstanceRecord,
  path: string,
  init?: { method: "POST"; body: unknown; timeoutMs?: number },
): Promise<T> {
  requireRest(rec);
  const auth = Buffer.from(`admin:${rec.settings.AdminPassword}`).toString("base64");
  const base = await baseUrl(rec);
  const timeoutMs = init?.timeoutMs ?? TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        ...(init ? { "Content-Type": "application/json" } : {}),
      },
      body: init ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // AbortSignal.timeout() rejects with a DOMException named TimeoutError;
    // everything else is a connection-level failure.
    if ((err as { name?: string } | null)?.name === "TimeoutError") {
      throw new RestError(`REST API 逾時(${Math.round(timeoutMs / 1000)} 秒內沒有回應)`, 504);
    }
    throw new RestError("無法連線到伺服器的 REST API — 伺服器可能未在運作中", 503);
  }
  if (res.status === 401) throw new RestError("REST API 認證失敗 — 管理員密碼可能不符", 401);
  if (!res.ok) throw new RestError(`REST API 回應 HTTP ${res.status}`, 502);

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const rest = {
  info: (rec: InstanceRecord) => call<RestServerInfo>(rec, "/info"),
  metrics: (rec: InstanceRecord) => call<RestMetrics>(rec, "/metrics"),
  players: async (rec: InstanceRecord) =>
    (await call<{ players: RestPlayer[] }>(rec, "/players")).players ?? [],
  /** Palworld 1.0+: world actor snapshot. */
  gameData: (rec: InstanceRecord) => call<GameDataSnapshot>(rec, "/game-data"),

  announce: (rec: InstanceRecord, message: string) =>
    call<void>(rec, "/announce", { method: "POST", body: { message } }),
  kick: (rec: InstanceRecord, userid: string, message?: string) =>
    call<void>(rec, "/kick", { method: "POST", body: { userid, message: message ?? "" } }),
  ban: (rec: InstanceRecord, userid: string, message?: string) =>
    call<void>(rec, "/ban", { method: "POST", body: { userid, message: message ?? "" } }),
  unban: (rec: InstanceRecord, userid: string) =>
    call<void>(rec, "/unban", { method: "POST", body: { userid } }),
  /** Blocks until the world is on disk — see SLOW_TIMEOUT_MS. Prefer
   *  saveWorld() (world-save.ts), which also tries RCON and dedupes callers. */
  save: (rec: InstanceRecord) =>
    call<void>(rec, "/save", { method: "POST", body: {}, timeoutMs: SLOW_TIMEOUT_MS }),
  shutdown: (rec: InstanceRecord, waittime: number, message: string) =>
    call<void>(rec, "/shutdown", {
      method: "POST",
      body: { waittime, message },
      timeoutMs: SLOW_TIMEOUT_MS,
    }),
};

/** One round-trip for the players tab: info + metrics + players. */
export async function getLiveStatus(rec: InstanceRecord): Promise<LiveStatus> {
  try {
    const [info, metrics, players] = await Promise.all([
      rest.info(rec),
      rest.metrics(rec),
      rest.players(rec),
    ]);
    return { available: true, info, metrics, players };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      info: null,
      metrics: null,
      players: [],
    };
  }
}
