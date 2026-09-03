import fs from "node:fs";
import path from "node:path";
import { DEFAULT_BACKUP_SCHEDULE, type BackupSchedule } from "@palserver/shared";
import type { InstanceStore, InstanceRecord } from "./store.js";
import type { ServerDriver } from "./driver.js";
import { activeWorldGuidAsync, createBackup, pruneBackups } from "./saves.js";
import { rest } from "./restapi.js";
import { emitAgentEvent } from "./events.js";

/**
 * Runs scheduled backups of each instance's active world.
 *
 * Ticks once a minute and backs up an instance when its interval has elapsed.
 * Only running instances are backed up (a stopped world isn't changing), and
 * `skipWhenEmpty` avoids piling up identical archives of an idle server.
 * The schedule is stored per instance so it survives agent restarts; the last
 * run's outcome is stored with it and surfaced in the UI.
 */

const TICK_MS = 60_000;

export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private store: InstanceStore,
    private driverFor: (rec: InstanceRecord) => ServerDriver,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private file(id: string): string {
    return path.join(this.store.instanceDir(id), "backup-schedule.json");
  }

  read(id: string): BackupSchedule {
    try {
      return { ...DEFAULT_BACKUP_SCHEDULE, ...JSON.parse(fs.readFileSync(this.file(id), "utf8")) };
    } catch {
      return { ...DEFAULT_BACKUP_SCHEDULE };
    }
  }

  write(id: string, schedule: BackupSchedule): BackupSchedule {
    fs.mkdirSync(this.store.instanceDir(id), { recursive: true });
    fs.writeFileSync(this.file(id), JSON.stringify(schedule, null, 2));
    return schedule;
  }

  update(id: string, patch: Partial<BackupSchedule>): BackupSchedule {
    return this.write(id, { ...this.read(id), ...patch });
  }

  private due(schedule: BackupSchedule): boolean {
    if (!schedule.enabled) return false;
    if (!schedule.lastRunAt) return true;
    const elapsedMinutes = (Date.now() - Date.parse(schedule.lastRunAt)) / 60_000;
    return elapsedMinutes >= schedule.intervalMinutes;
  }

  private async tick(): Promise<void> {
    for (const rec of this.store.list()) {
      const schedule = this.read(rec.id);
      if (!this.due(schedule) || rec.backend === "docker") continue;
      try {
        await this.runFor(rec, schedule);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.update(rec.id, { lastRunAt: new Date().toISOString(), lastResult: `失敗:${error}` });
        emitAgentEvent("backup.failed", rec.id, { error });
      }
    }
  }

  /** Runs a scheduled backup now; also used by the "test run" endpoint. */
  async runFor(rec: InstanceRecord, schedule = this.read(rec.id)): Promise<BackupSchedule> {
    const ctx = { instanceDir: this.store.instanceDir(rec.id) };
    const status = await this.driverFor(rec).status(rec, ctx);
    if (status.status !== "running") {
      return this.update(rec.id, {
        lastRunAt: new Date().toISOString(),
        lastResult: "略過:伺服器未在運作中",
      });
    }

    if (schedule.skipWhenEmpty) {
      // No REST API means we can't tell — back up rather than skip silently.
      const players = await rest.players(rec).catch(() => null);
      if (players?.length === 0) {
        return this.update(rec.id, {
          lastRunAt: new Date().toISOString(),
          lastResult: "略過:沒有玩家在線上",
        });
      }
    }

    const guid = await activeWorldGuidAsync(rec, ctx);
    if (!guid) {
      emitAgentEvent("backup.failed", rec.id, { error: "GameUserSettings.ini 未指定 DedicatedServerName" });
      return this.update(rec.id, {
        lastRunAt: new Date().toISOString(),
        lastResult: "失敗:GameUserSettings.ini 未指定 DedicatedServerName",
      });
    }

    const backup = await createBackup(rec, ctx, guid);
    const pruned = pruneBackups(ctx, guid, schedule.keep);
    emitAgentEvent("backup.completed", rec.id, { path: backup.name });
    return this.update(rec.id, {
      lastRunAt: new Date().toISOString(),
      lastResult:
        `成功:${backup.name}` +
        (pruned.length > 0 ? `(清除 ${pruned.length} 個舊備份)` : "") +
        (backup.flushedBeforeBackup ? "" : `(未先存檔:${backup.flushError ?? "存檔失敗"})`),
    });
  }
}
