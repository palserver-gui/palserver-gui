import { useCallback, useEffect, useMemo, useState } from "react";
import { FiAlertTriangle, FiEye, FiEyeOff, FiFileText, FiMessageSquare, FiShield, FiSearch } from "react-icons/fi";
import {
  PALDEFENDER_OPTIONS,
  PD_MOTD_MAX_LINES,
  PD_CATEGORY_LABELS,
  PD_MIN_VERSION,
  pdSupports,
  type PalDefenderConfig,
  type PalDefenderConfigStatus,
  type PdOptionCategory,
  type PdOptionKey,
  type PdOptionMeta,
  type PdOptionValue,
  type PdRestStatus,
  type ModsStatus,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { FileEditor } from "./FileManager";
import { ModInstallCard } from "./ModInstallCard";
import { RestStatusCard } from "./RestStatusCard";
import { t, useI18n } from "./i18n";
import { EmptyState, btn, btnGhost, card, errorCls, inputCls } from "./ui";

const KEYS = Object.keys(PALDEFENDER_OPTIONS) as PdOptionKey[];
const RAW_PATH = "Pal/Binaries/Win64/PalDefender/Config.json";
const effective = (values: PalDefenderConfig, k: PdOptionKey) =>
  values[k] ?? PALDEFENDER_OPTIONS[k].default;

/** textarea 內容 → MOTD 陣列:每行一則,去掉尾端空行,套用行數上限。 */
const motdLines = (text: string): string[] => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(0, PD_MOTD_MAX_LINES);
};

export function PalDefenderTab({
  client,
  instanceId,
  running,
  backend,
}: {
  client: AgentClient;
  instanceId: string;
  running: boolean;
  backend: "native" | "docker" | "k8s";
}) {
  useI18n();
  const [status, setStatus] = useState<PalDefenderConfigStatus | null>(null);
  const [draft, setDraft] = useState<PalDefenderConfig>({});
  const [motdDraft, setMotdDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingRaw, setEditingRaw] = useState<string | null>(null);
  const [rest, setRest] = useState<PdRestStatus | null>(null);
  // 版本管理(從「模組」分頁移來):更新到最新版 / 安裝測試版
  const [mods, setMods] = useState<ModsStatus | null>(null);
  const [verBusy, setVerBusy] = useState<"stable" | "beta" | "toggle" | null>(null);
  const [optSearch, setOptSearch] = useState("");

  // 最新穩定版(「有新版」徽章)與停用/啟用
  const [latest, setLatest] = useState<{ ue4ss: string | null; paldefender: string | null } | null>(null);
  useEffect(() => {
    client.modsLatest().then(setLatest).catch(() => {});
  }, [client]);
  const toggleEnabled = async () => {
    if (!mods) return;
    setVerBusy("toggle");
    setError(null);
    try {
      const next = await client.setModEnabled(instanceId, "paldefender", mods.paldefender.enabled === false);
      setMods(next);
      // docker/k8s:操作當下伺服器在運行中,新狀態要重啟才載入——明示生效語意(AC-03)。
      if (backend !== "native") {
        setNotice(t(next.paldefender.enabled === false ? "已停用,重啟伺服器後生效。" : "已啟用,重啟伺服器後生效。"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerBusy(null);
    }
  };

  const refresh = useCallback(async () => {
    try {
      const [next, restStatus, modStatus] = await Promise.all([
        client.palDefenderConfig(instanceId),
        client.palDefenderRest(instanceId).catch(() => null),
        client.mods(instanceId).catch(() => null),
      ]);
      setStatus(next);
      setRest(restStatus);
      setMods(modStatus);
      setDraft(Object.fromEntries(KEYS.map((k) => [k, effective(next.values, k)])));
      setMotdDraft(next.motd.join("\n"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dirtyKeys = useMemo(() => {
    if (!status) return [];
    return KEYS.filter((k) => draft[k] !== effective(status.values, k));
  }, [draft, status]);

  const motd = useMemo(() => motdLines(motdDraft), [motdDraft]);
  const motdDirty = !!status && JSON.stringify(motd) !== JSON.stringify(status.motd);
  const dirtyCount = dirtyKeys.length + (motdDirty ? 1 : 0);

  if (!status) return <p className="text-ink-muted">{error ?? t("載入中…")}</p>;


  const installVersion = async (channel: "stable" | "beta") => {
    if (channel === "beta" && !confirm(t("測試版(Beta)可能不穩定,但含較新的功能(例如玩家細節 API)。\n\n確定要安裝最新測試版嗎?"))) {
      return;
    }
    setVerBusy(channel);
    setError(null);
    try {
      await client.installMod(instanceId, "paldefender", channel);
      setNotice(t("安裝或更新後,重啟伺服器才會生效。"));
      setTimeout(() => setNotice(null), 3500);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerBusy(null);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await client.updatePalDefenderConfig(instanceId, { ...draft, motd });
      setNotice(t("已儲存並嘗試熱重載(若 RCON 未啟用則於重啟後生效)"));
      setTimeout(() => setNotice(null), 3500);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const grouped = new Map<string, PdOptionKey[]>();
  const q = optSearch.trim().toLowerCase();
  for (const key of KEYS) {
    // 搜尋:比對原始 key + 翻譯後標籤 + hint,留空顯示全部
    if (q) {
      const meta = PALDEFENDER_OPTIONS[key] as { label: string; hint?: string };
      const hit =
        key.toLowerCase().includes(q) ||
        t(meta.label).toLowerCase().includes(q) ||
        (meta.hint ? t(meta.hint).toLowerCase().includes(q) : false);
      if (!hit) continue;
    }
    const label = t(PD_CATEGORY_LABELS[PALDEFENDER_OPTIONS[key].category as PdOptionCategory]);
    grouped.set(label, [...(grouped.get(label) ?? []), key]);
  }

  const versionCard = (
    <ModInstallCard
      title={t("PalDefender 版本")}
      installed={!!mods?.paldefender.installed}
      version={mods?.paldefender.version}
      running={running}
      requiresStopped={backend === "native"}
      busy={verBusy !== null}
      busyLabel={t("安裝中…")}
      onInstall={() => void installVersion("stable")}
      onInstallBeta={() => void installVersion("beta")}
      enabled={mods?.paldefender.enabled}
      onToggleEnabled={() => void toggleEnabled()}
      latestVersion={latest?.paldefender}
      note={<>{t("「玩家細節(查看帕魯/背包)」需要 v1.8.0 以上;召喚、閒置據點清理與內建 Discord 推送需要 v1.9.0 以上。")}{t("安裝、更新或停用後,重啟伺服器才會生效。")}</>}
    />
  );

  if (!status.supported) {
    return (
      <div className="flex flex-col gap-4">
        {error && <p className={errorCls}>{error}</p>}
        {versionCard}
        <EmptyState icon={<FiShield />}>{status.reason}</EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className={errorCls}>{error}</p>}
      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
      )}

      {/* 版本管理(從「模組」分頁移來):放在編輯 Config.json 的標題卡上面 */}
      {versionCard}

      <div className={`${card} flex flex-wrap items-center justify-between gap-2`}>
        <p className="inline-flex items-center gap-2 text-sm font-extrabold">
          <FiShield className="size-4 text-pal" /> {t("PalDefender 反外掛設定")}
        </p>
        <button
          className={`${btnGhost} inline-flex items-center gap-1.5`}
          onClick={() => setEditingRaw(RAW_PATH)}
          disabled={!status.exists}
          title={status.exists ? t("直接編輯 Config.json") : t("檔案尚未產生")}
        >
          <FiFileText className="size-4" /> {t("編輯 Config.json")}
        </button>
      </div>
      {!status.exists && status.reason && <p className="text-[13px] text-sun">{status.reason}</p>}


      <RestStatusCard
        rest={rest}
        onToggle={async (enabled) => {
          setError(null);
          try {
            await client.setPalDefenderRestEnabled(instanceId, enabled);
            setNotice(enabled ? t("已啟用 REST API — 重啟伺服器後生效") : t("已停用 REST API — 重啟後生效"));
            setTimeout(() => setNotice(null), 4000);
            await refresh();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
        onProvisionToken={async () => {
          setError(null);
          try {
            await client.provisionPalDefenderToken(instanceId, rest?.hasToken ?? false);
            setNotice(t("存取權杖已就緒 — 若查詢顯示尚未生效,重啟伺服器一次"));
            setTimeout(() => setNotice(null), 4000);
            await refresh();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
        onSetPort={async (port) => {
          setError(null);
          try {
            await client.setPalDefenderRestPort(instanceId, port);
            setNotice(t("已更新 REST API 端口為 {port} — 重啟伺服器後生效", { port }));
            setTimeout(() => setNotice(null), 4000);
            await refresh();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />

      <div className={`${card} flex flex-col gap-2`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
            <FiMessageSquare className="size-4 text-pal" /> {t("登入公告 (MOTD)")}
          </h3>
          {motdDirty && <span className="text-xs font-bold text-sun">{t("未儲存")}</span>}
        </div>
        <p className="text-xs text-ink-muted">
          {t("玩家加入伺服器時顯示的訊息,每行一則;留空則不顯示。變更需重啟或 reloadcfg 生效。")}
        </p>
        <textarea
          className={`${inputCls} min-h-24 w-full resize-y font-mono`}
          value={motdDraft}
          onChange={(e) => setMotdDraft(e.target.value)}
          placeholder={t("歡迎來到伺服器!")}
          rows={4}
        />
      </div>

      <label className="relative w-fit">
        <FiSearch className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
        <input
          className={`${inputCls} w-56 py-1.5 pl-8 text-[13px]`}
          value={optSearch}
          placeholder={t("搜尋設定(名稱或原始 key)…")}
          onChange={(e) => setOptSearch(e.target.value)}
        />
      </label>

      {q && grouped.size === 0 && (
        <p className="py-4 text-center text-[13px] text-ink-muted">{t("沒有符合「{q}」的設定。", { q: optSearch.trim() })}</p>
      )}

      {[...grouped.entries()].map(([category, keys]) => (
        <div key={category} className={card}>
          <h3 className="mb-1 text-sm font-extrabold text-ink-muted">{category}</h3>
          {PALDEFENDER_OPTIONS[keys[0]].category === "webhook" && (
            <p className="mb-1 text-xs text-ink-muted">
              {t("由 PalDefender 直接推送到 Discord,不需要 GUI 在線。留空 = 停用該項。")}
              {!pdSupports(mods?.paldefender.version, "webhooks") &&
                ` ${t("目前安裝的版本是 {v},需要 {min} 以上才有這些設定。", {
                  v: mods?.paldefender.version ?? "?",
                  min: PD_MIN_VERSION.webhooks,
                })}`}
            </p>
          )}
          <div className="flex flex-col divide-y divide-line">
            {keys.map((key) => (
              <OptionRow
                key={key}
                optionKey={key}
                value={draft[key] ?? PALDEFENDER_OPTIONS[key].default}
                fileValue={status.values[key]}
                onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))}
              />
            ))}
          </div>
        </div>
      ))}

      {dirtyCount > 0 && (
        <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-(--radius-cute) border-2 border-sun/50 bg-card p-3 shadow-(--shadow-cute)">
          <span className="text-[13px] font-bold text-ink-muted">
            {t("小心~您有 {n} 項變更尚未儲存!", { n: dirtyCount })}
          </span>
          <div className="flex gap-2">
            <button className={btnGhost} onClick={() => void refresh()} disabled={saving}>
              {t("重置")}
            </button>
            <button className={btn} onClick={save} disabled={saving}>
              {saving ? t("儲存中…") : t("確定修改")}
            </button>
          </div>
        </div>
      )}

      {editingRaw && (
        <FileEditor
          client={client}
          instanceId={instanceId}
          path={editingRaw}
          onClose={() => setEditingRaw(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

function OptionRow({
  optionKey,
  value,
  fileValue,
  onChange,
}: {
  optionKey: PdOptionKey;
  value: PdOptionValue;
  fileValue: PdOptionValue | undefined;
  onChange: (value: PdOptionValue) => void;
}) {
  useI18n();
  const [revealed, setRevealed] = useState(false);
  const meta: PdOptionMeta = PALDEFENDER_OPTIONS[optionKey];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
      <div className="min-w-64 flex-1">
        <p className="text-sm font-bold">
          {t(meta.label)}
          {fileValue === undefined && (
            <span className="ml-2 text-xs font-normal text-ink-muted">{t("(未設定,使用預設)")}</span>
          )}
        </p>
        <p className="font-mono text-xs text-ink-muted">{optionKey}</p>
        {meta.hint && <p className="mt-1 max-w-xl text-xs text-ink-muted">{t(meta.hint)}</p>}
        {meta.warn && (
          <p className="mt-1 inline-flex max-w-xl items-start gap-1.5 text-xs text-sun">
            <FiAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {t(meta.warn)}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        {meta.type === "string" ? (
          <div className="flex items-center gap-1.5">
            <input
              type={meta.secret && !revealed ? "password" : "text"}
              className={`${inputCls} w-72 font-mono text-xs`}
              value={String(value ?? "")}
              placeholder={meta.placeholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onChange(e.target.value)}
            />
            {meta.secret && (
              <button
                type="button"
                className={`${btnGhost} px-2`}
                aria-label={revealed ? t("隱藏") : t("顯示")}
                title={revealed ? t("隱藏") : t("顯示")}
                onClick={() => setRevealed((v) => !v)}
              >
                {revealed ? <FiEyeOff className="size-4" /> : <FiEye className="size-4" />}
              </button>
            )}
          </div>
        ) : meta.type === "bool" ? (
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(value)}
            aria-label={t(meta.label)}
            onClick={() => onChange(!value)}
            className={`relative h-7 w-12 rounded-full transition ${value ? "bg-grass" : "bg-line"}`}
          >
            <span
              className={`absolute top-1 size-5 rounded-full bg-white shadow transition-all ${value ? "left-6" : "left-1"}`}
            />
          </button>
        ) : (
          <input
            type="number"
            className={`${inputCls} w-28 text-right`}
            value={String(value)}
            min={meta.min}
            max={meta.max}
            step={meta.type === "float" ? meta.step : 1}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isNaN(n)) onChange(meta.type === "int" ? Math.trunc(n) : n);
            }}
          />
        )}
      </div>
    </div>
  );
}
