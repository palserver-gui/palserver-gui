import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_RESTART_POLICY,
  type InstanceStatus,
  type RestartEvent,
  type RestartPolicy,
  type RestartReason,
  type WebhookEventType,
} from "@palserver/shared";
import type { DriverContext, ServerDriver } from "./driver.js";
import type { InstanceStore, InstanceRecord } from "./store.js";
import { rest } from "./restapi.js";
import { saveWorld } from "./world-save.js";
import { getPalDefenderConfig } from "./paldefender-config.js";
import { newestPalDefenderLogLines } from "./native.js";
import { cachedVersionSummary, refreshImageVersionSummary } from "./version.js";
import { emitAgentEvent } from "./events.js";

/**
 * Automatic restarts, three triggers:
 *  - scheduled: every N minutes, or at fixed times of day
 *  - memory:    sustained above a threshold (a single spike won't trip it)
 *  - crash:     the process exited on its own while we expected it up
 *
 * Planned restarts (scheduled/memory) warn players over the REST API and ask
 * the server to save first. Crash restarts skip that — the server is already
 * gone — and are rate-limited so a server that dies on boot doesn't get
 * restarted forever.
 */

/** How often policies are evaluated. Overridable to speed up tests. */
const TICK_MS = Number(process.env.PALSERVER_SUPERVISOR_TICK_MS ?? 30_000);
const MAX_EVENTS = 50;
const MAX_ANNOUNCE_SECONDS = 300;
/** A native server that exits within this window of starting never really came
 * up — a boot failure, not a mid-game crash. Palworld's own boot takes ~30-60s. */
const BOOT_GRACE_MS = 120_000;
/** After a graceful REST /shutdown (waittime 10s), how long we poll for the old
 * process to actually exit before force-stopping. Big worlds flush saves on the
 * way out, so this needs headroom beyond the announced waittime. */
const SHUTDOWN_EXIT_TIMEOUT_MS = 60_000;
/** k8s only: how long to let the announced shutdown countdown and the server's
 * own flush run before scaling the StatefulSet to zero. */
const K8S_SHUTDOWN_GRACE_MS = 45_000;

/** daily 模式的觸發鍵:以「預計實際重啟的時刻」(now + 公告秒數)對表 ——
 * 公告先行,重啟正落在使用者設定的 HH:MM,而不是晚 announceSeconds 才開始。
 * 回傳 null = 現在(含前導)不落在任何排定時刻。exported for tests. */
export function dailyFireKey(
  policy: Pick<RestartPolicy, "announceSeconds"> & { scheduled: Pick<RestartPolicy["scheduled"], "dailyTimes"> },
  now: Date,
): string | null {
  const lead = Math.min(Math.max(policy.announceSeconds, 0), MAX_ANNOUNCE_SECONDS);
  const target = new Date(now.getTime() + lead * 1000);
  const hhmm = `${String(target.getHours()).padStart(2, "0")}:${String(target.getMinutes()).padStart(2, "0")}`;
  if (!policy.scheduled.dailyTimes.includes(hhmm)) return null;
  return `${target.toDateString()} ${hhmm}`;
}

interface SupervisorState {
  /** we last observed it running, so an "exited" now means it crashed */
  wasRunning: boolean;
  /** when we last (re)started the process — anchors boot-failure detection */
  lastStartAt?: string;
  /** consecutive checks over the memory threshold */
  memoryStreak: number;
  /** ISO timestamps of recent restarts, for rate limiting */
  recentRestarts: string[];
  /** anchors the "interval" schedule */
  lastScheduledAt?: string;
  /** guards against firing a daily time twice within its minute */
  lastDailyFire?: string;
  events: RestartEvent[];
}

export type UpdateRestartPreparation = (rec: InstanceRecord) => Promise<InstanceRecord>;
export type UpdateRestartAction = (rec: InstanceRecord, ctx: DriverContext) => Promise<void>;
export type UpdateAvailabilityReader = (
  rec: InstanceRecord,
  ctx: DriverContext,
) => ReturnType<typeof cachedVersionSummary>;
export type ImageVersionRefresher = typeof refreshImageVersionSummary;

const emptyState = (): SupervisorState => ({
  wasRunning: false,
  memoryStreak: 0,
  recentRestarts: [],
  events: [],
});

export class RestartSupervisor {
  private timer: NodeJS.Timeout | null = null;
  /** instances currently mid-restart — skip them until they settle */
  private busy = new Set<string>();
  /** 上次觀測到的狀態 —— 用來偵測 running/exited/starting 轉移並 emit 給 webhook。
   *  只在記憶體(agent 重啟後以當下狀態重建基準,不會補發啟動時就已存在的狀態)。 */
  private lastStatus = new Map<string, InstanceStatus>();
  /** 上次觀測到的「有無可用更新」—— 只在 false→true(新版釋出)時 emit 一次,避免每 tick 重發。 */
  private lastUpdate = new Map<string, boolean>();
  private updateRestartPreparation: UpdateRestartPreparation | null = null;

  constructor(
    private store: InstanceStore,
    private driverFor: (rec: InstanceRecord) => ServerDriver,
    private updateBeforeStart?: UpdateRestartAction,
    private readUpdateSummary: UpdateAvailabilityReader = cachedVersionSummary,
    private refreshImageSummary: ImageVersionRefresher = refreshImageVersionSummary,
  ) {}

  async noteRuntimeStarted(rec: InstanceRecord, ctx: DriverContext): Promise<void> {
    try {
      await this.refreshImageSummary(rec, ctx, {
        runtimeRunning: true,
        force: true,
      });
    } catch {
      // Runtime readiness is authoritative; version evidence is best-effort.
    }
  }

  /** Register route-owned state reconciliation that must happen before an
   * update restart starts the freshly downloaded server. */
  setUpdateRestartPreparation(preparation: UpdateRestartPreparation): void {
    this.updateRestartPreparation = preparation;
  }

  /** Applying an update is best-effort. A download / image-pull / rollout
   * failure must never turn "bring the server up" into "the server stays
   * down" — that would hard-lock any host that temporarily can't reach Steam
   * or the registry, since every later start would fail on the same update.
   * Record it, start the version already on disk, retry on the next start. */
  private recordUpdateFallback(id: string, err: unknown): void {
    this.record(id, this.readState(id), {
      at: new Date().toISOString(),
      reason: "update",
      ok: false,
      detail: `套用新版失敗,改用現有版本啟動:${err instanceof Error ? err.message : String(err)}`,
    });
  }

  /** Apply a detected update before any caller starts an instance. */
  async applyUpdateBeforeStart(
    rec: InstanceRecord,
    ctx: DriverContext,
    options: { markRunning?: boolean; respectManualStop?: boolean } = {},
  ): Promise<boolean> {
    if (options.markRunning) {
      const state = this.readState(rec.id);
      state.wasRunning = true;
      this.writeState(rec.id, state);
    }
    if (this.updateBeforeStart) {
      const { updateAvailable } = this.readUpdateSummary(rec, ctx);
      if (updateAvailable === true) {
        try {
          await this.updateBeforeStart(rec, ctx);
        } catch (err) {
          this.recordUpdateFallback(rec.id, err);
        }
      }
    }
    return !options.respectManualStop || this.readState(rec.id).wasRunning;
  }

  /** Manual restart entry point: keep route-specific side effects while using
   * the same safe stop/wait/start sequence as scheduled restarts. */
  async restartForManual(
    rec: InstanceRecord,
    detail = "手動重啟",
    options: { announceSeconds?: number } = {},
  ): Promise<void> {
    if (this.busy.has(rec.id)) return;
    const ctx: DriverContext = { instanceDir: this.store.instanceDir(rec.id) };
    const state = this.readState(rec.id);
    state.wasRunning = true;
    this.writeState(rec.id, state);
    const policy = this.readPolicy(rec.id);
    if (options.announceSeconds !== undefined) policy.announceSeconds = options.announceSeconds;
    const prepare = async (value: InstanceRecord): Promise<InstanceRecord> => {
      await this.applyUpdateBeforeStart(value, ctx);
      return this.updateRestartPreparation ? this.updateRestartPreparation(value) : value;
    };
    await this.restart(
      rec,
      ctx,
      this.driverFor(rec),
      policy,
      state,
      "manual",
      detail,
      prepare,
    );
  }

  /** Public update entry point that keeps SupervisorState private while
   * reusing the same safe restart sequence as scheduled restarts. */
  async restartForUpdate(
    rec: InstanceRecord,
    detail = "伺服器更新完成",
    update?: UpdateRestartAction,
  ): Promise<void> {
    if (this.busy.has(rec.id)) return;
    const ctx: DriverContext = { instanceDir: this.store.instanceDir(rec.id) };
    const state = this.readState(rec.id);
    // An explicit update means "apply the downloaded server and bring it up",
    // even when the user started the update while the instance was stopped.
    state.wasRunning = true;
    this.writeState(rec.id, state);
    const prepare = async (value: InstanceRecord): Promise<InstanceRecord> => {
      if (update) await update(value, ctx);
      else if (this.updateBeforeStart) await this.updateBeforeStart(value, ctx);
      return this.updateRestartPreparation ? this.updateRestartPreparation(value) : value;
    };
    await this.restart(
      rec,
      ctx,
      this.driverFor(rec),
      this.readPolicy(rec.id),
      state,
      "update",
      detail,
      prepare,
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private policyFile = (id: string) => path.join(this.store.instanceDir(id), "restart-policy.json");
  private stateFile = (id: string) => path.join(this.store.instanceDir(id), "restart-state.json");

  readPolicy(id: string): RestartPolicy {
    try {
      const raw = JSON.parse(fs.readFileSync(this.policyFile(id), "utf8"));
      return {
        ...DEFAULT_RESTART_POLICY,
        ...raw,
        scheduled: { ...DEFAULT_RESTART_POLICY.scheduled, ...raw.scheduled },
        memory: { ...DEFAULT_RESTART_POLICY.memory, ...raw.memory },
        crash: { ...DEFAULT_RESTART_POLICY.crash, ...raw.crash },
      };
    } catch {
      return structuredClone(DEFAULT_RESTART_POLICY);
    }
  }

  writePolicy(id: string, policy: RestartPolicy): RestartPolicy {
    fs.mkdirSync(this.store.instanceDir(id), { recursive: true });
    fs.writeFileSync(this.policyFile(id), JSON.stringify(policy, null, 2));
    return policy;
  }

  private readState(id: string): SupervisorState {
    try {
      return { ...emptyState(), ...JSON.parse(fs.readFileSync(this.stateFile(id), "utf8")) };
    } catch {
      return emptyState();
    }
  }

  private writeState(id: string, state: SupervisorState): void {
    fs.mkdirSync(this.store.instanceDir(id), { recursive: true });
    fs.writeFileSync(this.stateFile(id), JSON.stringify(state, null, 2));
  }

  events(id: string): RestartEvent[] {
    return [...this.readState(id).events].reverse();
  }

  restartsLastHour(id: string): number {
    return this.recentWithinHour(this.readState(id).recentRestarts).length;
  }

  private recentWithinHour(stamps: string[]): string[] {
    const cutoff = Date.now() - 3_600_000;
    return stamps.filter((s) => Date.parse(s) >= cutoff);
  }

  private record(id: string, state: SupervisorState, event: RestartEvent): void {
    state.events.push(event);
    if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
    this.writeState(id, state);
    // native 的崩潰由 native driver 的 child exit 事件即時發 server.crash(更準),這裡不重複發;
    // 其餘(scheduled/memory/manual=restart、startup-failure)仍由這裡發,docker/k8s 的 crash 也由這裡發。
    if (event.reason === "crash" && this.store.get(id)?.backend === "native") return;
    // 這裡是重啟/啟動失敗事件的唯一寫入點 —— 一處 emit 覆蓋 restart / startup-failure(+ 非 native crash)。
    const type: WebhookEventType =
      event.reason === "crash"
        ? "server.crash"
        : event.reason === "startup-failure"
          ? "server.startup_failure"
          : "server.restart";
    emitAgentEvent(type, id, { reason: event.reason, ok: event.ok, detail: event.detail });
  }

  /** 狀態轉移 → 生命週期 webhook(running / starting / exited)。首次觀測只建基準不 emit,
   *  避免 agent 一啟動就對「本來就在跑」的伺服器發假的「已上線」。crash/排程重啟另有專屬
   *  事件(見 record),這裡是給一般手動開/關/重啟用的通用訊號,最多延遲一個 tick(~30s)。 */
  private emitStatusTransition(id: string, status: InstanceStatus): void {
    const prev = this.lastStatus.get(id);
    this.lastStatus.set(id, status);
    if (prev === undefined || prev === status) return;
    if (status === "running") emitAgentEvent("server.running", id, {});
    else if (status === "starting" || status === "restarting") emitAgentEvent("server.starting", id, {});
    else if (status === "exited") emitAgentEvent("server.exited", id, {});
  }

  /** 遊戲伺服器有新版可更新 → emit 一次(只在 false→true;null/未知不動)。快取由 agent 週期
   *  fetchLatest 刷新(見 index.ts),故新版釋出後最多一個 tick 內就會偵測到。 */
  private async emitUpdateTransition(
    rec: InstanceRecord,
    ctx: DriverContext,
    policy: RestartPolicy,
    status: InstanceStatus,
  ): Promise<void> {
    const { updateAvailable, gameVersion } = this.readUpdateSummary(rec, ctx);
    if (typeof updateAvailable !== "boolean") return; // null=未知(非 native/無快取)→ 不動
    const prev = this.lastUpdate.get(rec.id);
    this.lastUpdate.set(rec.id, updateAvailable);
    if (prev === false && updateAvailable === true) {
      emitAgentEvent("server.update_available", rec.id, { current: gameVersion ?? "", latest: "" });
      if (policy.autoUpdate && status === "running") {
        await this.restartForUpdate(rec, "偵測到新版本,已自動更新");
      }
    }
  }

  /** Fixed times of day: fire once when the clock reaches HH:MM. */
  private dailyDue(policy: RestartPolicy, state: SupervisorState, now: Date): boolean {
    const key = dailyFireKey(policy, now);
    return key !== null && state.lastDailyFire !== key;
  }

  private scheduledDue(policy: RestartPolicy, state: SupervisorState, now: Date): boolean {
    if (!policy.scheduled.enabled) return false;
    if (policy.scheduled.mode === "daily") return this.dailyDue(policy, state, now);
    const anchor = state.lastScheduledAt ?? state.recentRestarts.at(-1);
    if (!anchor) return false; // start counting from the first observed tick
    return (now.getTime() - Date.parse(anchor)) / 60_000 >= policy.scheduled.intervalMinutes;
  }

  private async tick(): Promise<void> {
    for (const rec of this.store.list()) {
      // docker: scheduled + memory restart only (crash handled by unless-stopped).
      // native: full crash/memory/scheduled. k8s: scheduled only — STS handles
      // Pod self-heal and "exited" (replicas=0) is a deliberate stop, not crash.
      if (this.busy.has(rec.id)) continue;
      try {
        await this.check(rec);
      } catch {
        // transient (server going down mid-check) — next tick re-evaluates
      }
    }
  }

  private async check(rec: InstanceRecord): Promise<void> {
    const ctx: DriverContext = { instanceDir: this.store.instanceDir(rec.id) };
    const driver = this.driverFor(rec);
    const policy = this.readPolicy(rec.id);
    const state = this.readState(rec.id);
    const now = new Date();
    const { status } = await driver.status(rec, ctx);
    // native 由 native driver 直接發精準的生命週期事件(starting/running/exited/crash,見 native.ts);
    // 這裡的輪詢轉移只給 docker/k8s 兜底(它們沒有 child handle / REST 探測那條路)。
    if (rec.backend !== "native") this.emitStatusTransition(rec.id, status);
    await this.refreshImageSummary(rec, ctx, { runtimeRunning: status === "running" });
    await this.emitUpdateTransition(rec, ctx, policy, status);

    if (status !== "running") {
      // Crashed if we saw it running before and nobody asked us to stop it.
      // k8s is excluded: its STS auto-restarts crashed Pods, and replicas=0
      // ("exited") is a user-initiated stop, not a crash we should fight.
      const crashCandidate = state.wasRunning && status === "exited" && policy.crash.enabled
        && rec.backend === "native";
      if (crashCandidate) {
        // PalDefender's `exitServerOnStartupFailure` makes the server exit on
        // boot when the plugin can't load. That reads as a crash, but restarting
        // just loops until the hourly cap — so detect it and stop with a reason.
        if (await this.isStartupFailure(rec, ctx, state, now)) {
          this.handleStartupFailure(rec, ctx, state);
        } else {
          await this.handleCrash(rec, ctx, driver, policy, state);
        }
        return;
      }
      if (state.wasRunning && status !== "exited") {
        state.wasRunning = false;
        this.writeState(rec.id, state);
      }
      return;
    }

    if (!state.wasRunning) {
      state.wasRunning = true;
      state.lastScheduledAt ??= now.toISOString();
      this.writeState(rec.id, state);
    }

    if (this.scheduledDue(policy, state, now)) {
      if (policy.scheduled.mode === "daily") {
        state.lastDailyFire = dailyFireKey(policy, now) ?? state.lastDailyFire;
      }
      await this.restart(rec, ctx, driver, policy, state, "scheduled", "已達排定的重啟時間");
      return;
    }

    if (policy.memory.enabled) {
      const stats = await driver.stats(rec, ctx);
      const memoryMB = stats ? stats.memoryBytes / (1 << 20) : 0;
      state.memoryStreak = memoryMB > policy.memory.thresholdMB ? state.memoryStreak + 1 : 0;
      this.writeState(rec.id, state);

      if (state.memoryStreak >= policy.memory.sustainedChecks) {
        state.memoryStreak = 0;
        await this.restart(
          rec,
          ctx,
          driver,
          policy,
          state,
          "memory",
          `記憶體 ${memoryMB.toFixed(0)} MB 持續超過 ${policy.memory.thresholdMB} MB`,
        );
      }
    }
  }

  /** A crash is really a PalDefender startup abort when: the server died during
   * boot (within the grace window of our last start) AND the user asked
   * PalDefender to exit the server on startup failure. Restarting can't help. */
  private async isStartupFailure(
    rec: InstanceRecord,
    ctx: DriverContext,
    state: SupervisorState,
    now: Date,
  ): Promise<boolean> {
    if (!state.lastStartAt) return false;
    if (now.getTime() - Date.parse(state.lastStartAt) >= BOOT_GRACE_MS) return false;
    try {
      const cfg = await getPalDefenderConfig(rec, ctx);
      return cfg.values.exitServerOnStartupFailure === true;
    } catch {
      return false;
    }
  }

  /** Stop the auto-restart loop and surface why, instead of restarting into the
   * same failure. Sets wasRunning=false so later ticks don't re-flag it. */
  private handleStartupFailure(rec: InstanceRecord, ctx: DriverContext, state: SupervisorState): void {
    state.wasRunning = false;
    // Only quote PalDefender logs written since this boot — the newest file by
    // mtime may be the *previous* process's shutdown tail, which reads like
    // evidence but is just a normal goodbye message.
    const bootMs = state.lastStartAt ? Date.parse(state.lastStartAt) : undefined;
    const hint = newestPalDefenderLogLines(rec, ctx, 1, bootMs)[0];
    this.record(rec.id, state, {
      at: new Date().toISOString(),
      reason: "startup-failure",
      ok: false,
      detail:
        "伺服器在啟動階段即結束,且 PalDefender 已開啟「啟動失敗時關閉伺服器」— 研判為 PalDefender 啟動失敗自我關閉,已停止自動重啟以免無限重啟迴圈。請查看 PalDefender 日誌修正原因,或關閉該選項與崩潰自動重啟其一。"
        + (hint ? ` 最後日誌:${hint}` : "(本次啟動期間沒有 PalDefender 日誌 — 外掛可能未載入,或伺服器在載入外掛前就結束了。)"),
    });
  }

  private async handleCrash(
    rec: InstanceRecord,
    ctx: DriverContext,
    driver: ServerDriver,
    policy: RestartPolicy,
    state: SupervisorState,
  ): Promise<void> {
    const recent = this.recentWithinHour(state.recentRestarts);
    if (recent.length >= policy.crash.maxPerHour) {
      state.wasRunning = false; // stop retrying until someone starts it manually
      state.recentRestarts = recent;
      this.record(rec.id, state, {
        at: new Date().toISOString(),
        reason: "crash",
        ok: false,
        detail: `一小時內已重啟 ${recent.length} 次,達到上限後停止自動重啟`,
      });
      return;
    }

    this.busy.add(rec.id);
    try {
      await this.applyUpdateBeforeStart(rec, ctx);
      const afterUpdate = this.readState(rec.id);
      if (!afterUpdate.wasRunning) {
        this.record(rec.id, afterUpdate, {
          at: new Date().toISOString(),
          reason: "crash",
          ok: false,
          detail: "更新準備期間偵測到手動停止 — 尊重停止指令,略過自動啟動。",
        });
        return;
      }
      const started = await driver.start(rec, ctx);
      const at = new Date().toISOString();
      if (started) {
        state.recentRestarts = [...recent, at];
        await this.noteRuntimeStarted(rec, ctx);
      }
      state.wasRunning = true;
      state.lastStartAt = at;
      this.record(rec.id, state, {
        at,
        reason: "crash",
        ok: true,
        detail: started
          ? `伺服器異常結束,已自動重啟(本小時第 ${recent.length + 1} 次)`
          : "伺服器異常結束,但偵測時已在執行(可能已被手動啟動),略過自動重啟",
      });
    } catch (err) {
      state.recentRestarts = [...recent, new Date().toISOString()];
      this.record(rec.id, state, {
        at: new Date().toISOString(),
        reason: "crash",
        ok: false,
        detail: `自動重啟失敗:${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.busy.delete(rec.id);
    }
  }

  /** Planned restart: warn players, flush the world, then stop and start. */
  async restart(
    rec: InstanceRecord,
    ctx: DriverContext,
    driver: ServerDriver,
    policy: RestartPolicy,
    state: SupervisorState,
    reason: RestartReason,
    detail: string,
    prepareBeforeStart?: UpdateRestartPreparation,
  ): Promise<void> {
    this.busy.add(rec.id);
    // interval 模式的下一輪從「本輪觸發」起算,而不是完成時 —— 否則每輪都往後
    // 漂移 announceSeconds + 關機等待(使用者回報 360 分鐘排程會越跑越晚)。
    const firedAt = new Date().toISOString();
    try {
      // 遊戲內公告用 GUI 儲存設定時寫入的在地化模板;沒存過(舊設定)退回內建繁中。
      // detail 留給重啟紀錄/log(內含動態數字,不進遊戲聊天室)。
      const tpl = policy.announceTemplates;
      const reasonLabel =
        reason === "scheduled" ? tpl?.reasonScheduled ?? "已達排定的重啟時間"
        : reason === "memory" ? tpl?.reasonMemory ?? "記憶體超標"
        : detail;
      const announceMsg = (n: number) =>
        (tpl?.restart ?? "伺服器將在 {n} 秒後重新啟動({reason})")
          .split("{n}").join(String(n))
          .split("{reason}").join(reasonLabel);
      const wait = Math.min(Math.max(policy.announceSeconds, 0), MAX_ANNOUNCE_SECONDS);
      if (wait > 0) {
        await rest
          .announce(rec, announceMsg(wait))
          .catch(() => {}); // REST off — restart anyway, just without warning
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
      // Save and wait for the world to flush to disk. saveWorld() blocks
      // for the flush itself (RCON Save / REST /save, long timeout), but the
      // server may still be finishing the write when it answers — stopping
      // too soon can corrupt save files, so settle a few seconds more.
      await saveWorld(rec).catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));

      // Remember the old process's identity (native: pid) before asking it to
      // exit — during the wait below this is how we tell "old process still
      // exiting" apart from "someone manually restarted and a NEW process is
      // running", which we must never kill.
      const oldRuntimeId = (await driver.status(rec, ctx)).runtimeId;

      // Try graceful shutdown first (server saves then exits cleanly).
      // Fall back to hard stop if REST is unavailable or shutdown fails.
      const shutdownOk = await rest
        .shutdown(rec, 10, announceMsg(10))
        .then(() => true)
        .catch(() => false);

      if (!shutdownOk) {
        await driver.stop(rec, ctx);
      } else {
        // StatefulSet controllers restart a Pod whose PID 1 exits while the
        // replica count remains 1, so k8s has to be scaled to zero for the
        // update preparation not to be bypassed by a replacement Pod. Don't do
        // it immediately though: rest.shutdown() only *schedules* the exit
        // (10s announced countdown, then the server's own flush), and scaling
        // straight away SIGTERMs the container mid-countdown. Wait until the
        // container drops out of Ready — that is PID 1 exiting — and only fall
        // through on the bound so a wedged server can't stall the restart.
        if (rec.backend === "k8s") {
          const graceDeadline = Date.now() + K8S_SHUTDOWN_GRACE_MS;
          while (Date.now() < graceDeadline) {
            if ((await driver.status(rec, ctx)).status !== "running") break;
            await new Promise((r) => setTimeout(r, 1000));
          }
          await driver.stop(rec, ctx);
        }
        // Graceful shutdown succeeded — but the server only *begins* exiting
        // after the announced waittime (10s), and flushing a big world can take
        // longer still. Poll until the old process is really gone: starting the
        // new one too early makes driver.start() see a live process and silently
        // no-op — the restart then never happens, and the old process's own
        // exit a few seconds later gets misread as a PalDefender startup
        // failure, which halts auto-restart entirely.
        const deadline = Date.now() + SHUTDOWN_EXIT_TIMEOUT_MS;
        for (;;) {
          const cur = await driver.status(rec, ctx);
          if (cur.status !== "running") break;
          if (oldRuntimeId !== null && cur.runtimeId !== null && cur.runtimeId !== oldRuntimeId) {
            // A different process took over mid-wait (manual restart from the
            // UI). The goal — a fresh server — is already met; hand over.
            // (Carry lastDailyFire so a daily schedule doesn't refire this
            // same minute — check() set it in memory only.)
            const cur2 = this.readState(rec.id);
            cur2.lastDailyFire = state.lastDailyFire;
            this.record(rec.id, cur2, {
              at: new Date().toISOString(),
              reason,
              ok: false,
              detail: "等待舊程序退出期間,伺服器已被手動重啟接手 — 本次排程重啟取消,不影響新程序。",
            });
            return;
          }
          if (Date.now() >= deadline) {
            // Still alive past the deadline — escalate like the REST-less path
            // (driver.stop verifies the PID and waits for it to die).
            await driver.stop(rec, ctx);
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // A manual stop during any of the waits above (announce / save /
      // shutdown) writes wasRunning=false via noteManualState. Respect it —
      // resurrecting a server the user just stopped is worse than skipping
      // one scheduled restart.
      const preStart = this.readState(rec.id);
      if (!preStart.wasRunning) {
        preStart.lastDailyFire = state.lastDailyFire;
        this.record(rec.id, preStart, {
          at: new Date().toISOString(),
          reason,
          ok: false,
          detail: "重啟等待期間偵測到手動停止 — 尊重停止指令,本次排程重啟取消(伺服器維持停止)。",
        });
        return;
      }

      // The server is already stopped by this point, so a failed update must
      // fall back to starting the version on disk (see recordUpdateFallback).
      let startRec = rec;
      try {
        if (prepareBeforeStart) startRec = await prepareBeforeStart(rec);
        else if (reason !== "update") await this.applyUpdateBeforeStart(rec, ctx);
      } catch (err) {
        startRec = rec;
        this.recordUpdateFallback(rec.id, err);
      }
      // The update/pull/rollout callback can take minutes. A manual stop during
      // that work must win over the eventual start.
      const afterPrepare = this.readState(rec.id);
      if (!afterPrepare.wasRunning) {
        afterPrepare.lastDailyFire = state.lastDailyFire;
        this.record(rec.id, afterPrepare, {
          at: new Date().toISOString(),
          reason,
          ok: false,
          detail: "更新準備期間偵測到手動停止 — 尊重停止指令,本次重啟取消(伺服器維持停止)。",
        });
        return;
      }
      const startDriver = prepareBeforeStart ? this.driverFor(startRec) : driver;
      const started = await startDriver.start(startRec, ctx);
      if (!started) {
        throw new Error("舊伺服器程序尚未退出,無法啟動新程序 — 本次重啟未執行(伺服器維持原狀)");
      }
      await this.noteRuntimeStarted(startRec, ctx);

      // Re-read state instead of writing back the copy we've held across a
      // wait that can span minutes — a concurrent manual start/stop updates
      // the state file, and clobbering it re-arms stale flags.
      const now = new Date().toISOString();
      const fresh = this.readState(rec.id);
      fresh.lastDailyFire = state.lastDailyFire; // set by check() at fire time
      fresh.recentRestarts = [...this.recentWithinHour(fresh.recentRestarts), now];
      fresh.lastScheduledAt = firedAt;
      fresh.wasRunning = true;
      fresh.lastStartAt = now;
      this.record(rec.id, fresh, { at: now, reason, ok: true, detail });
    } catch (err) {
      // Fresh read for the same reason as the success path; keep lastDailyFire
      // so a failed daily restart isn't re-attempted within the same minute.
      const cur = this.readState(rec.id);
      cur.lastDailyFire = state.lastDailyFire;
      this.record(rec.id, cur, {
        at: new Date().toISOString(),
        reason,
        ok: false,
        detail: `重啟失敗:${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.busy.delete(rec.id);
    }
  }

  /** Called when a human starts/stops an instance, so crash detection and the
   * interval schedule anchor to the new reality. */
  noteManualState(id: string, running: boolean): void {
    const state = this.readState(id);
    state.wasRunning = running;
    state.memoryStreak = 0;
    if (running) {
      state.lastStartAt = new Date().toISOString();
    }
    this.writeState(id, state);
  }
}
