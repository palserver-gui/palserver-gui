import { useCallback, useEffect, useMemo, useState } from "react";
import { FiAlertTriangle, FiTerminal } from "react-icons/fi";
import {
  LAUNCH_CATEGORY_LABELS,
  LAUNCH_OPTIONS,
  LAUNCH_OPTION_KEYS,
  type LaunchOptionCategory,
  type LaunchOptionKey,
  type LaunchOptionMeta,
  type LaunchOptionValue,
  type LaunchOptions,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { t, useI18n } from "./i18n";
import { btn, btnGhost, card, errorCls, inputCls, labelCls, Select } from "./ui";

const effective = (values: LaunchOptions, key: LaunchOptionKey) => values[key] ?? LAUNCH_OPTIONS[key].default;

/** 命令列啟動參數卡片:可重用於「引擎微調」(perf)與「設定(實例)」(general)分頁。
 * general 分類額外帶 Steam 查詢埠(queryport),它不在 LAUNCH_OPTIONS 裡而是
 * 實例的第一級欄位,所以獨立用 queryPort state 管理、儲存時一起送出。 */
export function LaunchOptionsCard({
  client,
  instanceId,
  category,
}: {
  client: AgentClient;
  instanceId: string;
  category: LaunchOptionCategory;
}) {
  useI18n();
  const keys = useMemo(
    () => LAUNCH_OPTION_KEYS.filter((k) => LAUNCH_OPTIONS[k].category === category),
    [category],
  );

  const [values, setValues] = useState<LaunchOptions | null>(null);
  const [queryPort, setQueryPort] = useState<number | null>(null);
  const [draft, setDraft] = useState<LaunchOptions>({});
  const [portDraft, setPortDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await client.launchOptions(instanceId);
      setValues(next.launchOptions);
      setQueryPort(next.queryPort);
      setDraft(Object.fromEntries(keys.map((k) => [k, effective(next.launchOptions, k)])));
      setPortDraft(next.queryPort === null ? "" : String(next.queryPort));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId, keys]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dirtyKeys = useMemo(() => {
    if (!values) return [];
    return keys.filter((k) => draft[k] !== effective(values, k));
  }, [draft, values, keys]);

  const portDirty = category === "general" && (queryPort === null ? "" : String(queryPort)) !== portDraft;
  const dirtyCount = dirtyKeys.length + (portDirty ? 1 : 0);

  if (!values) return <p className="text-ink-muted">{error ?? t("載入中…")}</p>;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: { launchOptions?: LaunchOptions; queryPort?: number | null } = {};
      if (dirtyKeys.length > 0) {
        patch.launchOptions = Object.fromEntries(dirtyKeys.map((k) => [k, draft[k]]));
      }
      if (portDirty) {
        const trimmed = portDraft.trim();
        patch.queryPort = trimmed === "" ? null : Number(trimmed);
      }
      await client.updateLaunchOptions(instanceId, patch);
      setNotice(t("已儲存,重啟伺服器後生效"));
      setTimeout(() => setNotice(null), 3000);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`${card} flex flex-col gap-3`}>
      <h3 className="inline-flex items-center gap-2 text-sm font-extrabold">
        <FiTerminal className="size-4 text-pal" /> {t(LAUNCH_CATEGORY_LABELS[category])}
      </h3>

      {error && <p className={errorCls}>{error}</p>}
      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
      )}

      {category === "general" && (
        <div className="flex flex-col gap-1.5 border-b border-line pb-3">
          <label className={labelCls}>
            {t("Steam 查詢埠(queryport)")}
            <input
              type="number"
              className={`${inputCls} w-32`}
              value={portDraft}
              min={1024}
              max={65535}
              placeholder="1024–65535"
              onChange={(e) => setPortDraft(e.target.value)}
            />
          </label>
          <p className="text-xs text-ink-muted">
            {t("同機多台伺服器的查詢埠必須不同,否則儲存時會回報衝突。")}
          </p>
        </div>
      )}

      <div className="flex flex-col divide-y divide-line">
        {keys.map((key) => (
          <OptionRow
            key={key}
            optionKey={key}
            value={draft[key] ?? LAUNCH_OPTIONS[key].default}
            onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))}
          />
        ))}
      </div>

      {dirtyCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-sun/50 bg-card-soft p-3">
          <span className="text-[13px] font-bold text-ink-muted">
            {t("小心~您有 {n} 項變更尚未儲存!(重啟伺服器後生效)", { n: dirtyCount })}
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
    </div>
  );
}

function OptionRow({
  optionKey,
  value,
  onChange,
}: {
  optionKey: LaunchOptionKey;
  value: LaunchOptionValue;
  onChange: (value: LaunchOptionValue) => void;
}) {
  useI18n();
  const meta: LaunchOptionMeta = LAUNCH_OPTIONS[optionKey];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
      <div className="min-w-64 flex-1">
        <p className="text-sm font-bold">{t(meta.label)}</p>
        {meta.arg && <p className="font-mono text-xs text-ink-muted">{optionKey}</p>}
        {meta.hint && <p className="mt-1 max-w-xl text-xs text-ink-muted">{t(meta.hint)}</p>}
        {meta.warn && (
          <p className="mt-1 inline-flex max-w-xl items-start gap-1.5 text-xs text-sun">
            <FiAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {t(meta.warn)}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        {meta.type === "bool" && (
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
        )}
        {meta.type === "int" && (
          <input
            type="number"
            className={`${inputCls} w-28 text-right`}
            value={String(value)}
            min={meta.min}
            max={meta.max}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isNaN(n)) onChange(Math.trunc(n));
            }}
          />
        )}
        {meta.type === "text" && (
          <input
            type="text"
            className={`${inputCls} w-72 font-mono`}
            value={String(value)}
            placeholder="-flagA -flagB=1"
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {meta.type === "enum" && (
          <Select
            className="min-w-36"
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
          >
            {(meta.choices ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        )}
      </div>
    </div>
  );
}
