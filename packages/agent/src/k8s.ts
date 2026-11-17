import * as k8s from "@kubernetes/client-node";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { InstanceStats, InstanceStatus, LogSource, LogSourceId } from "@palserver/shared";
import { buildLaunchArgs } from "@palserver/shared";
import type { ServerDriver, DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { configPlatformDir } from "./platform.js";
import {
  execInPod,
  findPodName,
  listStatefulSetPods,
  loadKubeConfig,
  ownedPodsForStatefulSet,
  readFileInPod,
  selectStatefulSetContainerName,
  writeFileInPod,
} from "./k8s-files.js";
import { mergeEnginePatch } from "./engine-ini-merge.js";
import { imageDigest, registryImageDigest } from "./image-digest.js";

/**
 * k8s backend driver.
 *
 * Drives a PalServer running as a StatefulSet (e.g. the thijsvanloef/palworld-server image)
 * via @kubernetes/client-node. The agent may run either in-cluster (a Pod with a service
 * account) or out-of-cluster (~/.kube/config, or an explicit kubeconfig path for SSH-tunnel
 * scenarios). Lifecycle is expressed as StatefulSet replica scaling: start = scale to 1,
 * stop = scale to 0. We never delete the StatefulSet — that preserves the PVC (saves).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function strategicMergeMiddleware(contentType = "application/strategic-merge-patch+json"): any {
  // Strategic-merge-patch content-type is required for scale subresource patches
  // so the API server merges `spec.replicas` instead of replacing the whole scale
  // object. Ported from PalworldManager k8s-controller.ts.
  //
  // @kubernetes/client-node 1.x 的 ObservableAPI pipe 鏈透過 rxjsStub.mergeMap
  // 呼叫 callback(value).toPromise()。httpApi.send() 回傳 Observable（有 toPromise），
  // 但 middleware 的 pre/post 如果回傳裸 Promise 就會 TypeError。用 of() 包一層
  // Observable-like（帶 toPromise 方法）即可相容。
  const of = (value: unknown) => ({ toPromise: () => Promise.resolve(value) });
  return {
    pre: (ctx: { setHeaderParam: (k: string, v: string) => void }) => {
      ctx.setHeaderParam("Content-Type", contentType);
      return of(ctx);
    },
    post: (ctx: unknown) => of(ctx),
  };
}

export interface K8sReadyObservation {
  status: InstanceStatus;
  failure?: string;
  snapshot?: K8sRestartBaseline;
}

export interface K8sRestartBaseline {
  podUid: string;
  containerName: string;
  restartCount: number;
}

/** How long stop() waits for the scaled-down Pod to actually disappear. Covers
 *  a generous terminationGracePeriodSeconds plus kubelet/PVC detach time. */
const K8S_STOP_TIMEOUT_MS = 180_000;

const K8S_START_FAILURE_REASONS = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
]);

function newestPod(pods: k8s.V1Pod[]): k8s.V1Pod | undefined {
  const timestamp = (value: Date | string | undefined): number =>
    value instanceof Date ? value.getTime() : Date.parse(value ?? "") || 0;
  return pods
    .filter((pod) => !pod.metadata?.deletionTimestamp)
    .sort((a, b) =>
      timestamp(b.metadata?.creationTimestamp) - timestamp(a.metadata?.creationTimestamp)
    )[0];
}

export function inspectK8sStartObservation(
  statefulSet: k8s.V1StatefulSet,
  pods: k8s.V1Pod[],
  statefulSetName: string,
  restartBaseline?: K8sRestartBaseline,
): K8sReadyObservation {
  const replicas = statefulSet.spec?.replicas ?? 0;
  if (replicas === 0) {
    return { status: "exited", failure: "啟動已取消：StatefulSet 已縮放為 0" };
  }

  const ownedPods = ownedPodsForStatefulSet(
    pods,
    statefulSetName,
    statefulSet.metadata?.uid,
  );
  const failure = ownedPods
    .flatMap((pod) => [
      ...(pod.status?.initContainerStatuses ?? []),
      ...(pod.status?.containerStatuses ?? []),
    ])
    .map((container) => container.state?.waiting?.reason)
    .find((reason): reason is string => Boolean(reason && K8S_START_FAILURE_REASONS.has(reason)));
  if (failure) return { status: "starting", failure };

  const pod = newestPod(ownedPods);
  const containerName = selectStatefulSetContainerName(statefulSet);
  const container = pod?.status?.containerStatuses?.find((entry) => entry.name === containerName);
  const snapshot = pod?.metadata?.uid && containerName && container
    ? {
        podUid: pod.metadata.uid,
        containerName,
        restartCount: container.restartCount,
      }
    : undefined;
  const podReady = pod?.status?.conditions?.some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  ) === true;
  const containersReady =
    (pod?.status?.containerStatuses?.length ?? 0) > 0 &&
    pod?.status?.containerStatuses?.every((entry) => entry.ready) === true;
  const generation = statefulSet.metadata?.generation ?? 0;
  const observedGeneration = statefulSet.status?.observedGeneration ?? 0;
  const revisionChanged = Boolean(
    statefulSet.status?.currentRevision &&
      statefulSet.status?.updateRevision &&
      statefulSet.status.currentRevision !== statefulSet.status.updateRevision,
  );
  const statefulSetReady =
    (statefulSet.status?.readyReplicas ?? 0) >= replicas &&
    (statefulSet.status?.updatedReplicas ?? 0) >= replicas &&
    observedGeneration >= generation &&
    !revisionChanged;
  const restartObserved =
    !restartBaseline ||
    Boolean(
      snapshot &&
        (
          snapshot.podUid !== restartBaseline.podUid ||
          (
            snapshot.containerName === restartBaseline.containerName &&
            snapshot.restartCount > restartBaseline.restartCount
          )
        ),
    );

  return {
    status: statefulSetReady && podReady && containersReady && restartObserved
      ? "running"
      : "starting",
    snapshot,
  };
}

async function observeK8sStart(
  appsApi: k8s.AppsV1Api,
  coreApi: k8s.CoreV1Api,
  namespace: string,
  statefulSetName: string,
  restartBaseline?: K8sRestartBaseline,
): Promise<K8sReadyObservation> {
  const [statefulSet, pods] = await Promise.all([
    appsApi.readNamespacedStatefulSet({ name: statefulSetName, namespace }),
    coreApi.listNamespacedPod({ namespace }),
  ]);
  return inspectK8sStartObservation(
    statefulSet,
    pods.items,
    statefulSetName,
    restartBaseline,
  );
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage = "Kubernetes StatefulSet 尚未 Ready",
): Promise<T> {
  if (timeoutMs <= 0) throw new Error(timeoutMessage);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(timeoutMessage)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForResultOrTick<T>(
  promise: Promise<T>,
  tickMs: number,
): Promise<T | { kind: "tick" }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<{ kind: "tick" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "tick" }), tickMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitForK8sReady(
  observe: () => Promise<K8sReadyObservation>,
  options: { maxAttempts?: number; pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 60);
  const pollMs = Math.max(0, options.pollMs ?? 5000);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 315_000);
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const observation = await withDeadline(observe(), deadline - Date.now());
    if (observation.failure) {
      throw new Error(`Kubernetes 啟動失敗：${observation.failure}`);
    }
    if (observation.status === "running") return;
    if (attempt + 1 < maxAttempts && pollMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  throw new Error("Kubernetes StatefulSet 尚未 Ready");
}

export async function retryWineSettingsSync(
  sync: () => Promise<void>,
  observe: () => Promise<K8sReadyObservation>,
  options: { maxAttempts?: number; pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 30);
  const pollMs = Math.max(1, options.pollMs ?? 5000);
  const deadline = Date.now() + Math.max(1, options.timeoutMs ?? 165_000);
  let lastError: unknown;
  const timeoutError = () => new Error(
    "Wine 設定同步逾時：無法寫入 PalWorldSettings.ini",
    { cause: lastError },
  );
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const syncResult = sync().then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw timeoutError();
      const outcome = await waitForResultOrTick(
        syncResult,
        Math.min(pollMs, remainingMs),
      );
      if (outcome.kind === "success") return;
      const observationRemainingMs = deadline - Date.now();
      if (observationRemainingMs <= 0) throw timeoutError();
      let observation: K8sReadyObservation;
      try {
        observation = await withDeadline(observe(), observationRemainingMs);
      } catch (error) {
        if (Date.now() >= deadline) throw timeoutError();
        throw error;
      }
      if (observation.failure) {
        throw new Error(`Kubernetes 啟動失敗：${observation.failure}`, {
          cause: outcome.kind === "failure" ? outcome.error : lastError,
        });
      }
      if (outcome.kind === "failure") {
        lastError = outcome.error;
        const retryDelayMs = Math.min(pollMs, deadline - Date.now());
        if (retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
        break;
      }
    }
  }
  const detail = lastError instanceof Error ? `：${lastError.message}` : "";
  throw new Error(`Wine 設定同步失敗：無法寫入 PalWorldSettings.ini${detail}`, {
    cause: lastError,
  });
}

export async function restartK8sContainer(
  captureBaseline: () => Promise<K8sRestartBaseline>,
  restart: () => Promise<unknown>,
): Promise<K8sRestartBaseline> {
  const baseline = await captureBaseline();
  await restart();
  return baseline;
}

export async function applyOptionalK8sConfigRestart(
  applyConfig: () => Promise<boolean>,
  restart: () => Promise<K8sRestartBaseline>,
): Promise<K8sRestartBaseline | undefined> {
  try {
    if (!(await applyConfig())) return undefined;
  } catch {
    // Optional config writes remain best-effort.
    return undefined;
  }
  // Once a config write succeeded, its rollout is no longer optional: hiding
  // this error would let the API accept a Ready Pod still running old config.
  return restart();
}

export const k8sDriver: ServerDriver = {
  async status(rec, _ctx): Promise<{ status: InstanceStatus; runtimeId: string | null }> {
    const namespace = rec.k8sNamespace!;
    const statefulSet = rec.k8sStatefulSet!;
    const kc = loadKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    try {
      const sts = await appsApi.readNamespacedStatefulSet({
        name: statefulSet,
        namespace,
      });
      const replicas = sts.spec?.replicas ?? 0;
      const ready = sts.status?.readyReplicas ?? 0;
      const updated = sts.status?.updatedReplicas ?? 0;
      const generation = sts.metadata?.generation ?? 0;
      const observedGeneration = sts.status?.observedGeneration ?? 0;
      const revisionChanged = Boolean(
        sts.status?.currentRevision &&
          sts.status?.updateRevision &&
          sts.status.currentRevision !== sts.status.updateRevision,
      );

      if (replicas === 0) {
        return { status: "exited", runtimeId: null };
      }
      if (
        ready < replicas ||
        updated < replicas ||
        observedGeneration < generation ||
        revisionChanged
      ) {
        return { status: "starting", runtimeId: null };
      }
      // running — surface the backing Pod name as the runtime id
      const podName = await findPodName(coreApi, namespace, statefulSet, sts.metadata?.uid);
      return { status: "running", runtimeId: podName };
    } catch {
      // StatefulSet missing / API unreachable — treat as not materialized.
      return { status: "missing", runtimeId: null };
    }
  },

  async start(rec, ctx): Promise<boolean> {
    const namespace = rec.k8sNamespace!;
    const statefulSet = rec.k8sStatefulSet!;
    const kc = loadKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    let wineRestartRequired = false;
    let restartBaseline: K8sRestartBaseline | undefined;
    const observeStart = (baseline?: K8sRestartBaseline) =>
      withDeadline(
        observeK8sStart(appsApi, coreApi, namespace, statefulSet, baseline),
        15_000,
      );
    const captureRestartBaseline = async (): Promise<K8sRestartBaseline> => {
      const observation = await observeStart();
      if (observation.failure) {
        throw new Error(`Kubernetes 啟動失敗：${observation.failure}`);
      }
      if (!observation.snapshot) {
        throw new Error("Kubernetes 啟動失敗：找不到可追蹤的 game-server container");
      }
      return observation.snapshot;
    };

    // Ensure Service exposes all ports the agent needs (game, query, REST, RCON).
    await ensureServicePorts(rec).catch(() => {});

    // Wine does not consume the Linux image's PORT/QUERY_PORT environment
    // variables. Keep its process arguments aligned with the instance record,
    // otherwise the UI can advertise one game port while PalServer listens on
    // another one.
    if (rec.runtime === "wine") {
      await ensureWineLaunchArgs(rec).catch(() => {});
    }

    // Sync store settings before scaling up. Wine image reads PalWorldSettings.ini
    // directly (not env vars). PVC = /palworld (entire install persisted).
    // DepotDownloader runs first in entrypoint, then we write ini over the default.
    if (rec.runtime === "wine") {
      const { renderPalWorldSettingsIni, WORLD_BOOTED_FILE } = await import("./settings-ini.js");
      const { writeFileInPod, makeDirInPod } = await import("./k8s-files.js");
      const iniContent = renderPalWorldSettingsIni(rec.settings);
      const iniDir = `Pal/Saved/Config/${configPlatformDir(rec)}`;
      const iniRelPath = `${iniDir}/PalWorldSettings.ini`;
      const podWasRunning = await statefulSetHasRunningPod(appsApi, coreApi, namespace, statefulSet);
      const scalePatch = { spec: { replicas: 1 } };
      await appsApi.patchNamespacedStatefulSetScale(
        { name: statefulSet, namespace, body: scalePatch },
        { middleware: [strategicMergeMiddleware()] } as unknown as k8s.Configuration,
      );
      // Wait for Pod to exist, then write ini. On first boot DepotDownloader
      // creates the dir; on subsequent boots it validates (fast). Retry until exec works.
      await retryWineSettingsSync(
        async () => {
          await makeDirInPod(rec, iniDir);
          await writeFileInPod(rec, iniRelPath, iniContent);
        },
        () => observeStart(),
      );
      // Keep the same manual-edit reconciliation contract as native/docker.
      // The file lives in the Pod, while the managed snapshot belongs to the
      // agent instance state.
      fs.mkdirSync(ctx.instanceDir, { recursive: true });
      fs.writeFileSync(path.join(ctx.instanceDir, "world-applied.json"), JSON.stringify(rec.settings));
      // These are also the settings the server boots with; it writes them back on shutdown.
      fs.writeFileSync(path.join(ctx.instanceDir, WORLD_BOOTED_FILE), JSON.stringify(rec.settings));
      wineRestartRequired = !podWasRunning;
    } else {
      const { applyEnvPatchK8s } = await import("./k8s-env-patch.js");
      await applyEnvPatchK8s(rec, rec.settings).catch(() => {});
      const scalePatch = { spec: { replicas: 1 } };
      await appsApi.patchNamespacedStatefulSetScale(
        { name: statefulSet, namespace, body: scalePatch },
        { middleware: [strategicMergeMiddleware()] } as unknown as k8s.Configuration,
      );
    }

    if (rec.engineSettings && Object.keys(rec.engineSettings).length > 0) {
      await new Promise((r) => setTimeout(r, 3000));
      // A first Wine boot also needs one restart after PalWorldSettings.ini is
      // written. Let that restart apply Engine.ini as well instead of killing
      // PID 1 twice; already-running Pods retain the existing Engine.ini flow.
      if (wineRestartRequired) {
        await applyEngineIniK8s(rec, false).catch(() => {});
      } else {
        const engineRestartBaseline = await applyOptionalK8sConfigRestart(
          async () => {
            await applyEngineIniK8s(rec, false);
            return true;
          },
          () => restartK8sContainer(
            captureRestartBaseline,
            () => rolloutRestart(rec),
          ),
        );
        if (engineRestartBaseline) restartBaseline = engineRestartBaseline;
      }
    }
    if (wineRestartRequired) {
      // PID 1 in the Wine image may accept `kill 1` without actually exiting.
      // Restart through the StatefulSet controller so a new Pod UID proves
      // that the synced ini is running before the API reports success.
      restartBaseline = await restartK8sContainer(
        captureRestartBaseline,
        () => rolloutRestart(rec),
      );
    }

    // Auto-configure PalDefender REST if PD is installed but not yet enabled.
    // This runs AFTER Palworld boots (PD generates RESTConfig.json on first boot).
    if (rec.runtime === "wine") {
      let pdRestartRequired = false;
      try {
        const pd = await import("./paldefender-rest.js");
        // Wait for PD to generate RESTConfig.json (retry for up to 5 min).
        for (let i = 0; i < 30; i++) {
          const status = await pd.getPdRestStatus(rec, { instanceDir: "" } as DriverContext);
          // 沒裝 PalDefender 就不用等 RESTConfig.json 了 —— 否則「原味」wine 實例
          // 每次啟動都會空轉滿 5 分鐘,連 /start API 都被卡住。
          if (!status.installed) break;
          if (status.configExists) {
            if (!status.enabled) {
              // PD generated defaults (Enabled=false). Override with our config.
              // Port was already assigned during install (in RESTConfig.json by preConfigureRestApi);
              // just enable + provision token. Keep the port PD already chose.
              const changed = await pd
                .setPdRestEnabled(rec, { instanceDir: "" } as DriverContext, true)
                .then(() => true, () => false);
              if (changed) pdRestartRequired = true;
            }
            if (!status.hasToken) {
              const changed = await pd
                .provisionPdToken(rec, { instanceDir: "" } as DriverContext, false)
                .then(() => true, () => false);
              if (changed) pdRestartRequired = true;
            }
            break;
          }
          await new Promise((r) => setTimeout(r, 10000));
        }
      } catch { /* PD not installed — skip */ }
      if (pdRestartRequired) {
        restartBaseline = await restartK8sContainer(
          captureRestartBaseline,
          () => rolloutRestart(rec),
        );
      }
      // Re-patch Service now that PD port may have changed during auto-config.
      await ensureServicePorts(rec).catch(() => {});
    }

    await waitForK8sReady(() => observeStart(restartBaseline));

    return true;
  },

  async stop(rec, _ctx): Promise<void> {
    const namespace = rec.k8sNamespace!;
    const statefulSet = rec.k8sStatefulSet!;
    const kc = loadKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const patch = { spec: { replicas: 0 } };
    await appsApi.patchNamespacedStatefulSetScale(
      { name: statefulSet, namespace, body: patch },
      { middleware: [strategicMergeMiddleware()] } as unknown as k8s.Configuration,
    );
    // Scaling only *asks* the controller to delete the Pod; the container then
    // gets its terminationGracePeriod to flush and exit. status() reports
    // "exited" the moment replicas hits 0, so without waiting here a caller
    // (restart / update rollout) would start the replacement while the old Pod
    // still holds the PVC. Wait until it is really gone.
    const deadline = Date.now() + K8S_STOP_TIMEOUT_MS;
    for (;;) {
      // Not listStatefulSetPods(): that one hides Pods with a deletionTimestamp,
      // which is exactly the state we are waiting to leave.
      const alive = await coreApi
        .listNamespacedPod({ namespace })
        .then((list) => list.items.filter((pod) =>
          pod.metadata?.ownerReferences?.some((owner) =>
            owner.kind === "StatefulSet" && owner.name === statefulSet && owner.controller !== false
          ),
        ))
        .catch(() => []);
      if (alive.length === 0) return;
      if (Date.now() >= deadline) return; // kubelet is stuck; don't block forever
      await new Promise((r) => setTimeout(r, 1000));
    }
  },

  async remove(rec, ctx): Promise<void> {
    // Scale down only — never delete the StatefulSet, so the PVC (saves) survive.
    await this.stop(rec, ctx);
  },

  async stats(rec, _ctx): Promise<InstanceStats | null> {
    // k8s 下透過 exec 讀容器的 cgroup 與 /proc。CPU 必須以同一 Pod 的
    // 累積時間差取樣，第一筆只建立基線，避免把 0 誤當成真實使用率。
    const namespace = rec.k8sNamespace!;
    const stsName = rec.k8sStatefulSet!;
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const podName = await findPodName(coreApi, namespace, stsName);
    if (!podName) return null;

    try {
      const now = Date.now();
      const cpuStatV2 = await readFirst(rec, ["/sys/fs/cgroup/cpu.stat"]);
      const usageMicros = cpuStatV2 !== null
        ? parseCpuStatUsageMicros(cpuStatV2)
        : parseCpuAcctUsageMicros(await readFirst(rec, ["/sys/fs/cgroup/cpuacct/cpuacct.usage"]));
      const cpuMaxV2 = await readFirst(rec, ["/sys/fs/cgroup/cpu.max"]);
      const cpuCores = cpuMaxV2 !== null
        ? parseCpuMaxCores(cpuMaxV2, await readFirst(rec, ["/proc/cpuinfo"]))
        : parseCpuQuotaCores(
          await readFirst(rec, ["/sys/fs/cgroup/cpu/cpu.cfs_quota_us"]),
          await readFirst(rec, ["/sys/fs/cgroup/cpu/cpu.cfs_period_us"]),
          await readFirst(rec, ["/proc/cpuinfo"]),
        );

      const memoryCurrent = await readFirst(rec, ["/sys/fs/cgroup/memory.current"]);
      const memoryV1 = await readFirst(rec, ["/sys/fs/cgroup/memory/memory.usage_in_bytes"]);
      const memoryBytes = parseBytes(memoryCurrent ?? memoryV1);
      const memoryMax = await readFirst(rec, ["/sys/fs/cgroup/memory.max"]);
      const memoryLimitV1 = await readFirst(rec, ["/sys/fs/cgroup/memory/memory.limit_in_bytes"]);
      const memoryLimitBytes = parseMemoryLimit(memoryMax ?? memoryLimitV1);

      // per-core 優先序:cgroup v1 usage_percpu(容器專屬)→ /proc/stat(host 全核)。
      const perCpuRaw = await readFirst(rec, ["/sys/fs/cgroup/cpuacct/cpuacct.usage_percpu"]);
      const perCpuMicros = parseUsagePerCpu(perCpuRaw); // 奈秒陣列
      const perCpuMicrosNorm = perCpuMicros?.map((ns) => ns / 1000) ?? null; // → 微秒
      const isContainerScope = perCpuMicrosNorm !== null;
      // cgroup v2 無 per-core → fallback /proc/stat(host 全核)。
      const procStat = !isContainerScope
        ? parseProcStatPerCore(await readFirst(rec, ["/proc/stat"]))
        : null;

      const previous = usageMicros === null ? undefined : k8sStatsSamples.get(rec.id);
      // computeCpuPercent 回單核基準(可破百);正規化為佔總算力 0–100%。
      const rawPercent = usageMicros === null || previous?.podName !== podName
        ? null
        : computeCpuPercent(previous, usageMicros, now);
      const cpuPercent = rawPercent != null && cpuCores > 0
        ? Math.max(0, Math.min(rawPercent / cpuCores, 100))
        : rawPercent;

      // per-core 差分(兩種來源各自算)。
      let perCore: (number | null)[] | null = null;
      let perCoreScope: "system" | "container" | undefined = undefined;
      if (perCpuMicrosNorm !== null) {
        perCoreScope = "container";
        const prevPerCore = previous?.perCoreMicros;
        if (prevPerCore && previous.podName === podName) {
          const wallMicros = (now - previous.atMs) * 1000;
          perCore = perCpuMicrosNorm.map((cur, i) => {
            const p = prevPerCore[i] ?? 0;
            return wallMicros > 0 && cur >= p ? Math.min(((cur - p) / wallMicros) * 100, 100) : null;
          });
        }
      } else if (procStat !== null) {
        perCoreScope = "system";
        const prevProcStat = previous?.procStatPerCore;
        if (prevProcStat && previous.podName === podName) {
          perCore = procStat.map((cur, i) => {
            const p = prevProcStat[i];
            if (!p) return null;
            const totalDelta = cur.total - p.total;
            if (totalDelta <= 0) return null;
            const idleDelta = cur.idle - p.idle;
            const idleRatio = Math.max(0, Math.min(idleDelta / totalDelta, 1));
            return Math.round((1 - idleRatio) * 1000) / 10;
          });
        }
      }

      if (usageMicros === null) k8sStatsSamples.delete(rec.id);
      else k8sStatsSamples.set(rec.id, {
        podName,
        usageMicros,
        atMs: now,
        perCoreMicros: perCpuMicrosNorm,
        procStatPerCore: procStat ?? undefined,
      });

      // uptime：從 /proc/uptime 的第一欄（秒）
      let uptimeSeconds: number | undefined;
      try {
        const upOut = await execInPod(rec, ["cat", "/proc/uptime"]);
        const statOut = await execInPod(rec, ["cat", "/proc/1/stat"]);
        const hzOut = await execInPod(rec, ["getconf", "CLK_TCK"]).catch(() => "100");
        uptimeSeconds = computeContainerUptimeSeconds(
          Number(upOut.trim().split(/\s+/)[0]),
          parseProcStatStartTicks(statOut),
          Number(hzOut.trim()) || 100,
        );
      } catch { /* best-effort */ }

      let processCount: number | undefined;
      try {
        const processOut = await execInPod(rec, [
          "sh",
          "-c",
          'n=0; for d in /proc/[0-9]*; do [ -r "$d/stat" ] && n=$((n+1)); done; echo "$n"',
        ]);
        const count = Number(processOut.trim());
        if (Number.isFinite(count) && count >= 0) processCount = count;
      } catch { /* best-effort */ }

      return {
        cpuPercent,
        cpuCores,
        perCore,
        perCoreScope,
        memoryBytes,
        memoryLimitBytes,
        processCount,
        uptimeSeconds,
      } satisfies InstanceStats;
    } catch {
      return null;
    }
  },

  async streamLogs(
    rec,
    _ctx,
    onLine: (line: string) => void,
    onEnd: () => void,
    _source?: LogSourceId,
    replay = 200,
  ): Promise<() => void> {
    const namespace = rec.k8sNamespace!;
    const statefulSet = rec.k8sStatefulSet!;
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const podName = await findPodName(coreApi, namespace, statefulSet);
    if (!podName) {
      onEnd();
      return () => {};
    }

    // k8s.Log writes the followed log stream into the supplied Writable and
    // resolves to an AbortController we use for cleanup on disconnect.
    const out = new PassThrough();
    let buffer = "";
    out.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.length > 0) onLine(line);
    });
    out.on("end", onEnd);
    out.on("error", onEnd);

    const logger = new k8s.Log(kc);
    const abort = await logger.log(namespace, podName, "", out, {
      follow: true,
      tailLines: replay,
    });

    return () => {
      abort.abort();
      out.destroy();
    };
  },

  logSources(_rec, _ctx): LogSource[] {
    // Pod stdout carries everything (game + container); there are no separate files.
    return [{ id: "agent" as const, label: "Pod 日誌", available: true }];
  },
};

type K8sStatsSample = {
  podName: string;
  usageMicros: number;
  atMs: number;
  /** per-core 歷史:cgroup v1 usage_percpu(微秒)或 null。 */
  perCoreMicros?: number[] | null;
  /** per-core 歷史:/proc/stat 每核 {idle, total}(jiffies);cgroup v2 fallback 用。 */
  procStatPerCore?: Array<{ idle: number; total: number }> | null;
};
const k8sStatsSamples = new Map<string, K8sStatsSample>();

async function readFirst(rec: InstanceRecord, paths: string[]): Promise<string | null> {
  for (const file of paths) {
    try {
      return await execInPod(rec, ["cat", file]);
    } catch {
      // Try the next cgroup layout.
    }
  }
  return null;
}

export function parseCpuStatUsageMicros(raw: string): number | null {
  const match = /(?:^|\n)usage_usec\s+(\d+)/.exec(raw);
  return match ? Number(match[1]) : null;
}

export function parseCpuAcctUsageMicros(raw: string | null): number | null {
  if (!raw) return null;
  const nanos = Number(raw.trim());
  return Number.isFinite(nanos) && nanos >= 0 ? nanos / 1000 : null;
}

function parseBytes(raw: string | null): number {
  if (!raw) return 0;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function parseMemoryLimit(raw: string | null): number {
  if (!raw || raw.trim() === "max") return 0;
  const value = Number(raw.trim());
  // cgroup v1 uses a very large sentinel for unlimited memory.
  return Number.isFinite(value) && value > 0 && value < 1e18 ? value : 0;
}

function cpuInfoCores(raw: string | null): number {
  if (!raw) return 1;
  const count = (raw.match(/^processor\s*:/gm) ?? []).length;
  return count > 0 ? count : 1;
}

export function parseCpuMaxCores(raw: string, cpuInfoRaw: string | null): number {
  const [quota, period] = raw.trim().split(/\s+/);
  if (!quota || quota === "max") return cpuInfoCores(cpuInfoRaw);
  const q = Number(quota);
  const p = Number(period);
  return Number.isFinite(q) && q > 0 && Number.isFinite(p) && p > 0 ? Math.max(q / p, 0.01) : cpuInfoCores(cpuInfoRaw);
}

export function parseCpuQuotaCores(quotaRaw: string | null, periodRaw: string | null, cpuInfoRaw: string | null): number {
  const quota = Number(quotaRaw?.trim());
  const period = Number(periodRaw?.trim());
  if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(period) || period <= 0) return cpuInfoCores(cpuInfoRaw);
  return Math.max(quota / period, 0.01);
}

export function parseProcStatStartTicks(raw: string): number | null {
  const commEnd = raw.lastIndexOf(")");
  if (commEnd < 0) return null;
  const fields = raw.slice(commEnd + 2).trim().split(/\s+/);
  const startTicks = Number(fields[19]); // field 22; fields start at field 3
  return Number.isFinite(startTicks) && startTicks >= 0 ? startTicks : null;
}

/** 解析 cgroup v1 cpuacct.usage_percpu:空白分隔的每核奈秒陣列(如 "56000000 48000000 ...")。 */
export function parseUsagePerCpu(raw: string | null): number[] | null {
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const vals = parts.map(Number);
  return vals.every((v) => Number.isFinite(v) && v >= 0) ? vals : null;
}

/** 解析 /proc/stat 的 per-core 行:每行 "cpuN user nice sys idle iowait irq softirq steal ..."。
 *  回傳每核 {idle, total}(jiffies);total = user+nice+sys+idle+iowait+irq+softirq+steal。 */
export function parseProcStatPerCore(raw: string | null): Array<{ idle: number; total: number }> | null {
  if (!raw) return null;
  const result: Array<{ idle: number; total: number }> = [];
  for (const line of raw.split("\n")) {
    const m = /^cpu(\d+)\s+(.*)$/.exec(line.trim());
    if (!m) continue; // 跳過 aggregate "cpu " 行(無數字)
    const vals = m[2].trim().split(/\s+/).map(Number);
    if (vals.length < 4 || vals.some((v) => !Number.isFinite(v))) continue;
    // [user, nice, sys, idle, iowait, irq, softirq, steal, ...]
    const [user, nice, sys, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = vals;
    result.push({ idle, total: user + nice + sys + idle + iowait + irq + softirq + steal });
  }
  return result.length > 0 ? result : null;
}

export function computeContainerUptimeSeconds(
  hostUptimeSeconds: number,
  startTicks: number | null,
  ticksPerSecond: number,
): number {
  if (!Number.isFinite(hostUptimeSeconds) || hostUptimeSeconds < 0) return 0;
  if (startTicks === null || !Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) {
    return Math.round(hostUptimeSeconds);
  }
  return Math.max(0, Math.round(hostUptimeSeconds - startTicks / ticksPerSecond));
}

export function computeCpuPercent(
  previous: K8sStatsSample | undefined,
  usageMicros: number,
  atMs: number,
): number | null {
  if (!previous || previous.atMs >= atMs || usageMicros < previous.usageMicros) return null;
  const wallMicros = (atMs - previous.atMs) * 1000;
  if (wallMicros <= 0) return null;
  return Math.max(0, (usageMicros - previous.usageMicros) / wallMicros * 100);
}

async function statefulSetHasRunningPod(
  appsApi: k8s.AppsV1Api,
  coreApi: k8s.CoreV1Api,
  namespace: string,
  statefulSet: string,
): Promise<boolean> {
  const sts = await appsApi.readNamespacedStatefulSet({ name: statefulSet, namespace });
  if ((sts.spec?.replicas ?? 0) < 1) return false;
  const pods = await listStatefulSetPods(
    coreApi,
    namespace,
    statefulSet,
    sts.metadata?.uid,
  );
  return pods.some((pod) => pod.status?.phase === "Running");
}

const k8sEngineIni = (rec: InstanceRecord): string =>
  `Pal/Saved/Config/${configPlatformDir(rec)}/Engine.ini`;

/** Re-apply managed Engine.ini into the running Pod, then kill PID 1 to restart. */
export async function applyEngineIniK8s(rec: InstanceRecord, restart = true): Promise<void> {
  if (!rec.engineSettings || Object.keys(rec.engineSettings).length === 0) return;
  const kc = loadKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const podName = await findPodName(coreApi, rec.k8sNamespace!, rec.k8sStatefulSet!).catch(() => null);
  if (!podName) return;
  const existing = await readFileInPod(rec, k8sEngineIni(rec)).catch(() => "");
  const merged = mergeEnginePatch(existing, rec.engineSettings!);
  await writeFileInPod(rec, k8sEngineIni(rec), merged);
  if (restart) await execInPod(rec, ["sh", "-c", "kill 1"]);
}

export function buildRolloutPatch(
  restartedAt: string,
): { spec: { template: { metadata: { annotations: Record<string, string> } } } } {
  return {
    spec: {
      template: {
        metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": restartedAt } },
      },
    },
  };
}

/** k8s rolling restart via annotation patch. */
export async function rolloutRestart(
  rec: InstanceRecord,
  options: {
    timeoutMs?: number;
    patch?: (body: ReturnType<typeof buildRolloutPatch>) => Promise<unknown>;
  } = {},
): Promise<void> {
  const patch = buildRolloutPatch(new Date().toISOString());
  const request = options.patch
    ? options.patch(patch)
    : (() => {
        const kc = loadKubeConfig();
        const appsApi = kc.makeApiClient(k8s.AppsV1Api);
        return appsApi.patchNamespacedStatefulSet(
          { name: rec.k8sStatefulSet!, namespace: rec.k8sNamespace!, body: patch },
          { middleware: [strategicMergeMiddleware()] } as unknown as k8s.Configuration,
        );
      })();
  await withDeadline(
    request,
    Math.max(1, options.timeoutMs ?? 15_000),
    "Kubernetes StatefulSet rollout request timed out",
  );
}

/** Read the image digest running in the Pod and compare it with the registry
 * digest for the StatefulSet image tag. */
export function inspectK8sImageVersion(
  statefulSet: k8s.V1StatefulSet,
  pod: k8s.V1Pod | null,
): { image: string | null; current: string | null } {
  const containerName = selectStatefulSetContainerName(statefulSet);
  const container = statefulSet.spec?.template?.spec?.containers?.find(
    (entry) => entry.name === containerName,
  );
  const image = container?.image ?? null;
  if (!image) return { image: null, current: null };
  const status = pod?.status?.containerStatuses?.find(
    (entry) => entry.name === containerName,
  );
  return {
    image,
    current: imageDigest(status?.imageID) ?? imageDigest(image),
  };
}

export async function imageVersionDigests(rec: InstanceRecord): Promise<{
  current: string | null;
  latest: string | null;
}> {
  const kc = loadKubeConfig();
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const sts = await appsApi.readNamespacedStatefulSet({ name: rec.k8sStatefulSet!, namespace: rec.k8sNamespace! });
  const podName = await findPodName(
    coreApi,
    rec.k8sNamespace!,
    rec.k8sStatefulSet!,
    sts.metadata?.uid,
  ).catch(() => null);
  const pod = podName
    ? await coreApi.readNamespacedPod({
        name: podName,
        namespace: rec.k8sNamespace!,
      }).catch(() => null)
    : null;
  const { image, current } = inspectK8sImageVersion(sts, pod);
  if (!image) return { current: null, latest: null };
  return { current, latest: await registryImageDigest(image) };
}

/**
 * Ensure the game-server Service exposes all ports the agent needs to reach:
 * game (UDP), query (UDP), REST API (TCP), RCON (TCP), and PalDefender REST (TCP).
 * Missing ports are added via a strategic merge patch. Called on start so the
 * agent never depends on the user having pre-configured every Service port.
 */
export async function ensureServicePorts(rec: InstanceRecord): Promise<void> {
  if (!rec.k8sServiceName || !rec.k8sNamespace) return;
  const kc = loadKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);

  // Read current Service to see which ports are already exposed.
  let svc: k8s.V1Service;
  try {
    const resp = await coreApi.readNamespacedService({ name: rec.k8sServiceName, namespace: rec.k8sNamespace });
    svc = resp;
  } catch {
    return; // Service doesn't exist — nothing to patch.
  }

  const existingPorts = new Set(
    (svc.spec?.ports ?? []).map((p: k8s.V1ServicePort) => `${p.port}/${p.protocol ?? "TCP"}`),
  );
  const desiredPorts: { name: string; port: number; protocol: string }[] = [
    { name: "game", port: rec.gamePort, protocol: "UDP" },
  ];
  if (rec.queryPort) desiredPorts.push({ name: "steam", port: rec.queryPort, protocol: "UDP" });
  if (rec.settings.RESTAPIEnabled) {
    desiredPorts.push({ name: "rest-api", port: Number(rec.settings.RESTAPIPort), protocol: "TCP" });
  }
  if (rec.settings.RCONEnabled) {
    desiredPorts.push({ name: "rcon", port: Number(rec.settings.RCONPort), protocol: "TCP" });
  }
  // PalDefender REST port (dynamic, read from RESTConfig.json if PD installed).
  if (rec.runtime === "wine") {
    try {
      const { readPdPort } = await import("./paldefender-rest.js");
      const pdPort = await readPdPort(rec, { instanceDir: "" } as DriverContext).catch(() => null);
      if (pdPort) desiredPorts.push({ name: "pd-rest", port: pdPort, protocol: "TCP" });
    } catch { /* PD not installed yet */ }
  }

  // Build the desired port list and reconcile: add missing ports, update changed ones.
  const current = (svc.spec?.ports ?? []).map((p: k8s.V1ServicePort) => ({
    name: p.name ?? "", port: p.port ?? 0, targetPort: p.targetPort ?? p.port ?? 0, protocol: p.protocol ?? "TCP",
  }));
  const desiredMap = new Map(desiredPorts.map((p) => [p.name, p]));
  let changed = false;
  const result: typeof current = [...current];
  for (const [name, desired] of desiredMap) {
    const idx = result.findIndex((p) => p.name === name);
    if (idx === -1) {
      result.push({ name, port: desired.port, targetPort: desired.port, protocol: desired.protocol });
      changed = true;
    } else if (result[idx].port !== desired.port) {
      result[idx] = { name, port: desired.port, targetPort: desired.port, protocol: desired.protocol };
      changed = true;
    }
  }
  if (!changed) return;

  await coreApi.patchNamespacedService(
    {
      name: rec.k8sServiceName,
      namespace: rec.k8sNamespace,
      body: { spec: { ports: result } },
    },
    // A JSON merge patch replaces the complete port list. Strategic merge
    // uses Service port as its list key on this cluster and can collapse a
    // TCP/UDP pair that happens to share a numeric port.
    { middleware: [strategicMergeMiddleware("application/merge-patch+json")] } as unknown as k8s.Configuration,
  );
}

// RFC 6902 patches are used for list fields whose merge key varies by
// Kubernetes resource/version (for example StatefulSet container args).
// Keep the Observable-like wrapper compatible with @kubernetes/client-node 1.x.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonPatchMiddleware(): any {
  const of = (value: unknown) => ({ toPromise: () => Promise.resolve(value) });
  return {
    pre: (ctx: { setHeaderParam: (k: string, v: string) => void }) => {
      ctx.setHeaderParam("Content-Type", "application/json-patch+json");
      return of(ctx);
    },
    post: (ctx: unknown) => of(ctx),
  };
}

/** Keep the Wine container's explicit listener arguments in sync with the record. */
async function ensureWineLaunchArgs(rec: InstanceRecord): Promise<void> {
  if (!rec.k8sStatefulSet || !rec.k8sNamespace) return;
  const kc = loadKubeConfig();
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const sts = await appsApi.readNamespacedStatefulSet({
    name: rec.k8sStatefulSet,
    namespace: rec.k8sNamespace,
  });
  const containers = sts.spec?.template?.spec?.containers ?? [];
  const containerIndex = Math.max(0, containers.findIndex((item) => item.name === "palworld-server"));
  const container = containers[containerIndex];
  if (!container) throw new Error("找不到 game-server 容器定義");

  const desired = [
    ...buildLaunchArgs(rec.launchOptions),
    `-port=${rec.gamePort}`,
    ...(rec.queryPort ? [`-queryport=${rec.queryPort}`] : []),
  ];
  const current = container.args ?? [];
  if (current.length === desired.length && current.every((arg, index) => arg === desired[index])) return;

  await appsApi.patchNamespacedStatefulSet(
    {
      name: rec.k8sStatefulSet,
      namespace: rec.k8sNamespace,
      body: [{
        op: container.args ? "replace" : "add",
        path: `/spec/template/spec/containers/${containerIndex}/args`,
        value: desired,
      }],
    },
    { middleware: [jsonPatchMiddleware()] } as unknown as k8s.Configuration,
  );
}

// Keep the historical k8s.ts import surface for saves.ts and engine-ini.ts.
export {
  deletePathInPod,
  downloadFileInPod,
  execInPod,
  execInPodBuffer,
  listDirInPod,
  makeDirInPod,
  readFileInPod,
  resolvePodPath,
  tarDirInPod,
  untarIntoPod,
  uploadFileInPod,
  writeFileBytesInPod,
  writeFileInPod,
} from "./k8s-files.js";
export { findPodName, loadKubeConfig } from "./k8s-files.js";
