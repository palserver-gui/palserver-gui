import { useCallback, useEffect, useState } from "react";
import { FiPackage, FiFolder, FiTrash2, FiAlertTriangle } from "react-icons/fi";
import type { ModComponent, ModsStatus, WorkshopModsStatus } from "@palserver/shared";
import type { AgentClient } from "./api";
import { FileBrowserDialog } from "./FileManager";
import { ModInstallCard } from "./ModInstallCard";
import { t, useI18n } from "./i18n";
import { EmptyState, btn, btnGhost, card, errorCls, DismissibleWarning } from "./ui";

/** 下載/安裝卡住(超過 10 秒)的黃色警告彈窗:樣式比照公告彈窗(置中卡片),配色改黃色(sun)醒目。
 *  常見原因是舊版本遺留、沒真正關掉的殭屍 PalServer 進程佔用著 DLL,擋住模組覆蓋安裝。 */
function SlowInstallWarning({ onClose }: { onClose: () => void }) {
  useI18n();
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgb(35_32_48/0.55)] p-6 backdrop-blur-[3px]">
      <div className={`${card} w-[460px] max-w-full border-sun/60 bg-sun/10`}>
        <h2 className="inline-flex items-center gap-2 text-lg font-extrabold text-sun">
          <FiAlertTriangle className="size-5 shrink-0" /> {t("下載卡住了?可能有殘留進程")}
        </h2>
        <div className="mt-3 space-y-2 text-[13px] leading-relaxed text-sun">
          <p>
            {t(
              "下載/安裝已超過 10 秒還沒完成,多半是舊版本遺留、沒真正關掉的殭屍 PalServer 進程還佔用著檔案(dwmapi.dll 等),擋住模組覆蓋安裝。請擇一處理後再試:",
            )}
          </p>
          <ul className="list-disc space-y-1 pl-5 font-bold">
            <li>{t("重新開機(推薦,最徹底)")}</li>
            <li>{t("或開「工作管理員 → 詳細資料」,結束殘留的 PalServer-Win64-Shipping-Cmd.exe 後再試")}</li>
          </ul>
        </div>
        <div className="mt-4 flex justify-end">
          <button className={btn} onClick={onClose}>
            {t("我知道了")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ModsTab({
  client,
  instanceId,
  running,
  onModsChanged,
}: {
  client: AgentClient;
  instanceId: string;
  running: boolean;
  /** 安裝/移除模組後通知外層(讓 PalDefender 分頁的 gating 同步)。 */
  onModsChanged?: () => void;
}) {
  useI18n();
  const [mods, setMods] = useState<ModsStatus | null>(null);
  // 各元件最新穩定版(「有新版」徽章);null=查詢失敗或尚未載入
  const [latest, setLatest] = useState<{ ue4ss: string | null; paldefender: string | null } | null>(null);
  const [pakMods, setPakMods] = useState<{ name: string; size: number; enabled: boolean }[]>([]);
  const [workshop, setWorkshop] = useState<WorkshopModsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState<string | null>(null);
  // 安裝下載超過 10 秒:多半是舊版遺留的殭屍 PalServer 佔用檔案擋住覆蓋,跳黃色警告提示處理。
  const [slowInstall, setSlowInstall] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [modStatus, pakList, workshopStatus] = await Promise.allSettled([
        client.mods(instanceId),
        client.listPakMods(instanceId),
        client.workshopMods(instanceId),
      ]);
      if (modStatus.status === "fulfilled") setMods(modStatus.value);
      if (pakList.status === "fulfilled") setPakMods(pakList.value.mods);
      if (workshopStatus.status === "fulfilled") setWorkshop(workshopStatus.value);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    client.modsLatest().then(setLatest).catch(() => {});
  }, [client]);

  const install = async (component: ModComponent, channel: "stable" | "beta" = "stable") => {
    if (channel === "beta" && !confirm(t("開發版(zDev)含 UE4SS 除錯主控台與開發工具、體積較大,一般伺服器不需要,主要供模組開發。\n\n確定要安裝開發版嗎?"))) {
      return;
    }
    setBusy(component);
    setError(null);
    setSlowInstall(false);
    // 下載/安裝超過 10 秒:通常是殭屍 PalServer 佔用檔案卡住覆蓋安裝(擴充解壓遇鎖檔會一直等)。
    const slowTimer = setTimeout(() => setSlowInstall(true), 10_000);
    try {
      await client.installMod(instanceId, component, channel);
      await refresh();
      onModsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(slowTimer);
      setSlowInstall(false);
      setBusy(null);
    }
  };

  const setComponentEnabled = async (component: ModComponent, enabled: boolean) => {
    setBusy(component);
    setError(null);
    try {
      setMods(await client.setModEnabled(instanceId, component, enabled));
      onModsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (name: string, enabled: boolean) => {
    try {
      setMods(await client.toggleLuaMod(instanceId, name, enabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!mods) return <p className="text-ink-muted">{error ?? t("載入中…")}</p>;

  if (!mods.supported) {
    return (
      <div className="flex flex-col gap-4">
        {error && <p className={errorCls}>{error}</p>}
        <EmptyState icon={<FiPackage />}>{mods.reason}</EmptyState>
        {(mods.serverInstalled ?? true) && (
        <PakModCard
          pakMods={pakMods}
          busy={!!busy}
          onToggle={async (name, enabled) => {
            try { setBusy(name); await client.togglePakMod(instanceId, name, enabled); await refresh(); }
            catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            finally { setBusy(null); }
          }}
          onRemove={async (name) => {
            if (!confirm(t("確定要移除 {name}？", { name }))) return;
            try { setBusy(name); await client.removePakMod(instanceId, name); await refresh(); }
            catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            finally { setBusy(null); }
          }}
        />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {slowInstall && <SlowInstallWarning onClose={() => setSlowInstall(false)} />}
      {error && <p className={errorCls}>{error}</p>}
      <DismissibleWarning id="warn-mods-compat">
        <span className="inline-flex items-start gap-2">
          <FiAlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {t("每次")} <b>{t("Palworld 改版")}</b>{t("後,PalDefender / UE4SS 常會")}<b>{t("暫時無法使用")}</b>{t(",要等模組作者釋出相容版本(通常改版後幾天內)。若改版後伺服器啟動異常或閃退,先回這裡")}<b>{t("更新到最新版")}</b>{t(",或先按")}<b>{t("停用")}</b>{t("(不刪檔,Lua 模組與設定都保留)再開服。")}
          </span>
        </span>
      </DismissibleWarning>
      {running && (
        <p className="rounded-xl bg-sun/10 px-3 py-2 text-[13px] font-bold text-sun">
          {t("伺服器運作中:安裝、更新或移除模組需要先停止伺服器(執行中時模組檔案被鎖定)。")}
        </p>
      )}
      <ModInstallCard
        title={t("UE4SS 模組載入器")}
        desc={t("Lua / Blueprint 模組的執行環境。安裝後即可在下方管理 Lua 模組。")}
        installed={mods.ue4ss.installed}
        version={mods.ue4ss.version}
        running={running}
        busy={busy === "ue4ss"}
        onInstall={() => void install("ue4ss")}
        onInstallBeta={() => void install("ue4ss", "beta")}
        enabled={mods.ue4ss.enabled}
        onToggleEnabled={() => void setComponentEnabled("ue4ss", mods.ue4ss.enabled === false)}
        latestVersion={latest?.ue4ss}
        note={t("安裝或更新後,重啟伺服器才會生效。")}
      />
      <div className={card}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold text-ink-muted">{t("Lua 模組(UE4SS)")}</h3>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setBrowsing(mods.luaModsDir!)}
            disabled={mods.luaModsDir === null}
            title={mods.luaModsDir ?? t("先安裝 UE4SS")}
          >
            <FiFolder className="size-4" /> {t("開啟 Lua 模組資料夾")}
          </button>
        </div>
        {mods.luaMods.length === 0 ? (
          <EmptyState compact>
            {mods.luaModsDir === null
              ? t("尚無 Lua 模組。先安裝 UE4SS,之後就能在此上傳與管理模組。")
              : t("尚無 Lua 模組。用上方的「開啟 Lua 模組資料夾」上傳模組資料夾。")}
          </EmptyState>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {mods.luaMods.map((m) => (
              <div key={m.name} className="flex items-center justify-between py-2.5">
                <span className="text-sm font-bold">{m.name}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={m.enabled}
                  onClick={() => toggle(m.name, !m.enabled)}
                  className={`relative h-7 w-12 rounded-full transition ${m.enabled ? "bg-grass" : "bg-line"}`}
                >
                  <span
                    className={`absolute top-1 size-5 rounded-full bg-white shadow transition-all ${m.enabled ? "left-6" : "left-1"}`}
                  />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {browsing !== null && (
        <FileBrowserDialog
          client={client}
          instanceId={instanceId}
          initialPath={browsing}
          onClose={() => {
            setBrowsing(null);
            void refresh();
          }}
        />
      )}

      {workshop?.supported && (
        <WorkshopModCard
          status={workshop}
          busy={!!busy}
          onBrowse={() => setBrowsing(workshop.workshopDir ?? "Mods/Workshop")}
          onToggle={async (packageName, enabled) => {
            try { setBusy(packageName); setWorkshop(await client.toggleWorkshopMod(instanceId, packageName, enabled)); }
            catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            finally { setBusy(null); }
          }}
          onToggleGlobal={async (enabled) => {
            try { setBusy("workshop-global"); setWorkshop(await client.setWorkshopGlobal(instanceId, enabled)); }
            catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            finally { setBusy(null); }
          }}
        />
      )}

      <PakModCard
        pakMods={pakMods}
        busy={!!busy}
        onBrowse={() => setBrowsing("Pal/Content/Paks")}
        onToggle={async (name, enabled) => {
          try { setBusy(name); await client.togglePakMod(instanceId, name, enabled); await refresh(); }
          catch (e) { setError(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(null); }
        }}
        onRemove={async (name) => {
          if (!confirm(t("確定要移除 {name}？", { name }))) return;
          try { setBusy(name); await client.removePakMod(instanceId, name); await refresh(); }
          catch (e) { setError(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(null); }
        }}
      />
    </div>
  );
}

function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: () => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-50 ${on ? "bg-grass" : "bg-line"}`}
    >
      <span className={`absolute top-1 size-5 rounded-full bg-white shadow transition-all ${on ? "left-6" : "left-1"}`} />
    </button>
  );
}

/** Steam Workshop 模組卡片(官方 1.0 模組系統;僅 native Windows)。
 *  開關寫 Mods/PalModSettings.ini 的 ActiveModList / bGlobalEnableMod,重啟伺服器後生效。 */
function WorkshopModCard({
  status,
  busy,
  onBrowse,
  onToggle,
  onToggleGlobal,
}: {
  status: WorkshopModsStatus;
  busy: boolean;
  onBrowse: () => void;
  onToggle: (packageName: string, enabled: boolean) => Promise<void>;
  onToggleGlobal: (enabled: boolean) => Promise<void>;
}) {
  useI18n();
  return (
    <div className={card}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <FiPackage className="size-5 text-pal" />
        <h3 className="text-sm font-extrabold">{t("Steam Workshop 模組(官方模組系統)")}</h3>
        <span className="rounded-full bg-pal/10 px-2 py-0.5 text-[11px] font-bold text-pal">{t("僅 Windows")}</span>
        <button className={`${btnGhost} ml-auto inline-flex items-center gap-1.5`} onClick={onBrowse}>
          <FiFolder className="size-4" /> {t("開啟 Workshop 資料夾")}
        </button>
      </div>
      <p className="mb-3 break-words text-[13px] text-ink-muted">
        {t(
          "在客戶端訂閱後,把 Steam/steamapps/workshop/content/1623730/<ID>/ 底下的模組資料夾複製到伺服器的 {dir},這裡就會列出。只有 Info.json 標 IsServer 的模組在伺服器上有作用;開關改動後重啟伺服器生效。",
          { dir: status.workshopDir ?? "Mods/Workshop" },
        )}
      </p>
      {!status.iniExists && (
        <p className="mb-3 text-xs text-ink-muted">
          {t("PalModSettings.ini 尚未生成(伺服器首次啟動後會自動建立);切換開關時會先建一份。")}
        </p>
      )}
      <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <span className="text-sm font-bold">{t("模組總開關(bGlobalEnableMod)")}</span>
        <Switch on={status.globalEnabled} disabled={busy} label={t("模組總開關(bGlobalEnableMod)")} onChange={() => void onToggleGlobal(!status.globalEnabled)} />
      </div>
      {status.mods.length === 0 && status.orphanActive.length === 0 ? (
        <EmptyState compact>{t("尚無 Workshop 模組。用「開啟 Workshop 資料夾」上傳模組資料夾(內含 Info.json)。")}</EmptyState>
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {status.mods.map((m) => (
            <div key={m.packageName} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
                  <span className="truncate">{m.name}</span>
                  {m.version && <span className="text-xs font-normal text-ink-muted">v{m.version}</span>}
                  {!m.isServer && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-sun/15 px-2 py-0.5 text-[11px] font-bold text-sun"
                      title={t("Info.json 的 InstallRule 沒有 IsServer:true,伺服器不會載入這個模組")}
                    >
                      <FiAlertTriangle className="size-3" /> {t("非伺服器模組")}
                    </span>
                  )}
                </p>
                <p className="truncate font-mono text-xs text-ink-muted">
                  {m.packageName}
                  {m.author && <span className="ml-2 font-sans">{m.author}</span>}
                </p>
              </div>
              <Switch on={m.enabled} disabled={busy} label={m.name} onChange={() => void onToggle(m.packageName, !m.enabled)} />
            </div>
          ))}
          {status.orphanActive.map((pkg) => (
            <div key={`orphan-${pkg}`} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-bold">{pkg}</p>
                <p className="text-xs text-sun">{t("ActiveModList 有列、但 Workshop 資料夾找不到這個模組")}</p>
              </div>
              <Switch on disabled={busy} label={pkg} onChange={() => void onToggle(pkg, false)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Pak mod 管理卡片（跨平台：native/docker/k8s）。 */
function PakModCard({
  pakMods,
  busy,
  onToggle,
  onRemove,
  onBrowse,
}: {
  pakMods: { name: string; size: number; enabled: boolean }[];
  busy: boolean;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
  /** 開啟 Paks 資料夾(檔案管理);未提供就不顯示按鈕。 */
  onBrowse?: () => void;
}) {
  const fmtSize = (n: number) =>
    n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n > 0 ? `${(n / (1 << 10)).toFixed(0)} KB` : "—";

  return (
    <div className={card}>
      <div className="mb-2 flex items-center gap-2">
        <FiPackage className="size-5 text-grass" />
        <h3 className="text-sm font-extrabold">{t("Pak 模組")}</h3>
        <span className="rounded-full bg-grass/10 px-2 py-0.5 text-[11px] font-bold text-grass">
          {t("跨平台")}
        </span>
        {onBrowse && (
          <button
            className={`${btnGhost} ml-auto inline-flex items-center gap-1.5`}
            onClick={onBrowse}
          >
            <FiFolder className="size-4" /> {t("開啟 Paks 資料夾")}
          </button>
        )}
      </div>
      <p className="mb-3 text-[13px] text-ink-muted">
        {t(".pak 檔放入 Pal/Content/Paks/ 後由遊戲引擎自動載入,不需 UE4SS。透過檔案管理上傳 pak 後在此管理。")}
      </p>
      {pakMods.length === 0 ? (
        <EmptyState compact>{t("目前沒有 pak 模組。")}</EmptyState>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {pakMods.map((mod) => (
            <li key={mod.name} className="flex items-center justify-between gap-2 rounded-lg bg-cream px-3 py-2 text-[13px]">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${mod.enabled ? "bg-grass/15 text-grass" : "bg-ink/10 text-ink-muted"}`}
                  onClick={() => onToggle(mod.name, !mod.enabled)}
                  disabled={busy}
                >
                  {mod.enabled ? t("啟用") : t("停用")}
                </button>
                <span className="truncate font-mono">{mod.name}</span>
                <span className="shrink-0 text-ink-muted">{fmtSize(mod.size)}</span>
              </div>
              <button
                className="shrink-0 text-error/70 hover:text-error"
                onClick={() => onRemove(mod.name)}
                disabled={busy}
              >
                <FiTrash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

