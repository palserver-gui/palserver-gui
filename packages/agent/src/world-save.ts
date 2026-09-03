import type { InstanceRecord } from "./store.js";
import { rconExec } from "./rcon.js";
import { rest, SLOW_TIMEOUT_MS } from "./restapi.js";

/**
 * "Save the world now" with the failure modes of a large world in mind.
 *
 * - RCON `Save` first when RCON is enabled: it runs on its own port, so a
 *   10-second flush doesn't tie up the REST server that the players/metrics
 *   polling (5 s budget) depends on. REST `/save` is the fallback when RCON
 *   is off or fails.
 * - Both paths get a long budget (SLOW_TIMEOUT_MS); the old 5 s default was
 *   cut short by any world over a few hundred MB.
 * - Concurrent callers for the same instance (scheduled backup, manual
 *   backup, health scan, restart) share one in-flight save instead of each
 *   asking the server to flush again — they all "fought for the same API".
 */

export type SaveVia = "rcon" | "rest";
export interface SaveWorldResult {
  via: SaveVia;
}

export interface WorldSaverDeps {
  rconSave: (rec: InstanceRecord) => Promise<string>;
  restSave: (rec: InstanceRecord) => Promise<void>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The stock server answers `Complete Save`; PalDefender answers similarly.
 * An "Unknown command" style reply means the save did not happen. */
export function rconSaveSucceeded(output: string): boolean {
  return !/unknown command|not found|error|fail/i.test(output);
}

export function createWorldSaver(deps: WorldSaverDeps) {
  const inflight = new Map<string, Promise<SaveWorldResult>>();

  async function saveOnce(rec: InstanceRecord): Promise<SaveWorldResult> {
    const reasons: string[] = [];

    if (rec.settings.RCONEnabled) {
      try {
        const out = await deps.rconSave(rec);
        if (rconSaveSucceeded(out)) return { via: "rcon" };
        reasons.push(`RCON:${out || "(空回應)"}`);
      } catch (err) {
        reasons.push(`RCON:${errText(err)}`);
      }
    } else {
      reasons.push("RCON:未啟用");
    }

    try {
      await deps.restSave(rec);
      return { via: "rest" };
    } catch (err) {
      reasons.push(`REST:${errText(err)}`);
    }

    throw new Error(`RCON/REST 存檔失敗或逾時 — ${reasons.join(";")}`);
  }

  return function saveWorld(rec: InstanceRecord): Promise<SaveWorldResult> {
    const existing = inflight.get(rec.id);
    if (existing) return existing;
    const p = saveOnce(rec).finally(() => inflight.delete(rec.id));
    inflight.set(rec.id, p);
    return p;
  };
}

export const saveWorld = createWorldSaver({
  rconSave: (rec) => rconExec(rec, "Save", { timeoutMs: SLOW_TIMEOUT_MS }),
  restSave: (rec) => rest.save(rec),
});
