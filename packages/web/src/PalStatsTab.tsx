import { useCallback, useEffect, useMemo, useState } from "react";
import { FiAlertTriangle, FiEdit2, FiList, FiStar, FiTrash2 } from "react-icons/fi";
import { GiSheep } from "react-icons/gi";
import {
  hasFeature,
  PAL_ROW_VARIANTS,
  PAL_STAT_CATEGORY_LABELS,
  PAL_STAT_KEYS,
  PAL_STAT_OPTIONS,
  palRowName,
  type PalRowVariantId,
  type PalStatCategory,
  type PalStatKey,
  type PalStatMeta,
  type PalStatValues,
  type PalStatsStatus,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { EntityPicker } from "./EntityPicker";
import { ModInstallCard } from "./ModInstallCard";
import { useGameData, palIconUrl, displayName } from "./gameData";
import { usePalStatsDefaults, resolveRowCase } from "./palStatsDefaults";
import { t, useI18n } from "./i18n";
import { SponsorLockNotice, EmptyState, btn, btnGhost, card, errorCls, inputCls, DismissibleWarning } from "./ui";

/** 空字串 = 不覆寫(維持既有值 / 交給 PalSchema 原始預設)。 */
function numOrUndef(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** row 名反解成 帕魯 id + 變體,給「已修改的帕魯」清單顯示用。 */
function parseRow(row: string): { palId: string; variant: PalRowVariantId } {
  for (const v of PAL_ROW_VARIANTS) {
    if (v.prefix && row.startsWith(v.prefix)) return { palId: row.slice(v.prefix.length), variant: v.id };
  }
  return { palId: row, variant: "normal" };
}

const emptyDraft = () =>
  Object.fromEntries(PAL_STAT_KEYS.map((k) => [k, ""])) as Record<PalStatKey, string>;

/**
 * 帕魯物種數值編輯器(贊助者先行版 pal-stats):透過 PalSchema 修改
 * DT_PalMonsterParameter 的物種基礎值(HP / 攻防 / 移速 / 捕獲率等)。
 * 未解鎖時整組表單照樣顯示,但變灰、不可操作,並提示去設定頁輸入識別碼。
 */
export function PalStatsTab({
  client,
  instanceId,
  running,
}: {
  client: AgentClient;
  instanceId: string;
  /** 伺服器運行中 + auto-reload 已開 → 儲存即熱重載,通知文案不同。 */
  running?: boolean;
}) {
  useI18n();
  const gameData = useGameData();
  // 原版數值(placeholder/大小寫校正);檔案缺失時為空物件,一切照舊
  const defaults = usePalStatsDefaults();
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [status, setStatus] = useState<PalStatsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [saving, setSaving] = useState(false);

  const [palId, setPalId] = useState("");
  const [variant, setVariant] = useState<PalRowVariantId>("normal");
  const [draft, setDraft] = useState<Record<PalStatKey, string>>(emptyDraft);

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.palStats(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("pal-stats", l)))
      .catch(() => setEntitled(false));
  }, [client, instanceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const locked = false;
  const row = palId.trim() ? resolveRowCase(defaults, palRowName(palId.trim(), variant)) : "";
  // 該 row 的原版數值(有資料檔才有;給 placeholder 與變體存在性判斷)
  const original = row && defaults ? defaults[row] : undefined;
  const hasDefaults = defaults != null && Object.keys(defaults).length > 0;

  // 該資料列目前已存的值(儲存基準),用來算「哪些欄位改過」與載入表單預設。
  const savedValues = useMemo<PalStatValues>(
    () => (row && status ? (status.rows.find((r) => r.row === row)?.values ?? {}) : {}),
    [row, status],
  );
  const savedStr = useCallback(
    (k: PalStatKey) => (savedValues[k] != null ? String(savedValues[k]) : ""),
    [savedValues],
  );
  const loadDraft = useCallback(
    () =>
      setDraft(
        Object.fromEntries(PAL_STAT_KEYS.map((k) => [k, savedStr(k)])) as Record<PalStatKey, string>,
      ),
    [savedStr],
  );

  // 選擇的帕魯 / 變體改變,或資料重新整理後,把該 row 現有值載回表單當預設。
  useEffect(() => {
    loadDraft();
  }, [loadDraft]);

  // 世界設定同款 dirty 追蹤:只有和已存值不同的欄位才算「未儲存的變更」。
  const dirtyKeys = useMemo(
    () => PAL_STAT_KEYS.filter((k) => draft[k] !== savedStr(k)),
    [draft, savedStr],
  );

  const grouped = useMemo(() => {
    const m = new Map<PalStatCategory, PalStatKey[]>();
    for (const k of PAL_STAT_KEYS) {
      const cat = PAL_STAT_OPTIONS[k].category;
      m.set(cat, [...(m.get(cat) ?? []), k]);
    }
    return m;
  }, []);

  if (!status) return <p className="text-ink-muted">{error ?? t("載入中…")}</p>;

  if (!status.schema.supported) {
    return (
      <div className="flex flex-col gap-4">
        {entitled === false && (
          <SponsorLockNotice>{t("這是贊助者先行版功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}</SponsorLockNotice>
        )}
        <EmptyState icon={<GiSheep />}>{status.schema.reason ?? status.reason}</EmptyState>
      </div>
    );
  }

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await client.installPalSchema(instanceId);
      setNotice(t("PalSchema 已是最新版,伺服器下次啟動後生效"));
      setTimeout(() => setNotice(null), 4000);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const save = async () => {
    if (!row) return;
    setSaving(true);
    setError(null);
    try {
      const values = Object.fromEntries(
        dirtyKeys.map((k) => [k, numOrUndef(draft[k])]).filter(([, v]) => v !== undefined),
      ) as PalStatValues;
      const next = await client.updatePalStats(instanceId, row, values);
      setStatus(next);
      setNotice(
        running && next.schema.autoReload
          ? t("已儲存,PalSchema 會自動熱重載 — 對新生成/新遭遇的帕魯生效;若沒生效再重啟伺服器。")
          : t("已儲存,伺服器重啟後生效"),
      );
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // 清空所有物種數值調整。刻意不受贊助者鎖限制:贊助到期的使用者也能改回原設定。
  const clearAll = async () => {
    if (
      !confirm(
        t("確定要刪除所有物種數值調整嗎?所有帕魯會改回原本設定,重啟伺服器後生效,此動作無法復原。"),
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const next = await client.clearPalStats(instanceId);
      setStatus(next);
      setNotice(
        running && next.schema.autoReload
          ? t("已刪除所有物種數值調整,PalSchema 會自動熱重載;若沒生效再重啟伺服器。")
          : t("已刪除所有物種數值調整,重啟伺服器後生效"),
      );
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error && <p className={errorCls}>{error}</p>}
      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
      )}

      {locked && (
        <SponsorLockNotice>{t("這是贊助者先行版功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}</SponsorLockNotice>
      )}

      <div className={locked ? "pointer-events-none opacity-55" : undefined}>
        <ModInstallCard
          title={t("帕魯物種數值編輯器")}
          titleExtra={
            <span className="inline-flex items-center gap-1 rounded-full bg-pal/10 px-2 py-0.5 text-xs font-bold text-pal">
              <FiStar className="size-3" /> {t("贊助者")}
            </span>
          }
          desc={t("透過社群開發的 PalSchema mod 修改物種基礎數值(HP / 近戰攻擊 / 遠程攻擊 / 防禦 / 移速 / 捕獲率等),改動寫在 DataTable patch,不動存檔本身。")}
          installed={status.schema.installed}
          version={status.schema.version ? `PalSchema ${status.schema.version}` : null}
          running={false}
          busy={installing}
          busyLabel={status.schema.installed ? t("更新中…") : t("安裝中…")}
          onInstall={install}
          installLabel={t("安裝 PalSchema")}
          updateLabel={t("更新 PalSchema")}
          installTitle={t("重新下載最新版 PalSchema 與相依的 UE4SS(遊戲改版後模組失效時先做這個)")}
          enabled={status.schema.enabled}
          onToggleEnabled={
            status.schema.enabled !== undefined
              ? () => {
                  void (async () => {
                    setInstalling(true);
                    setError(null);
                    try {
                      setStatus(await client.setPalSchemaEnabled(instanceId, status.schema.enabled === false));
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setInstalling(false);
                    }
                  })();
                }
              : undefined
          }
        >
          {!status.schema.installed && (
            <div className="mt-2">
              <DismissibleWarning id="warn-palstats-risk">
                <span className="inline-flex items-start gap-2">
                  <FiAlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {t(
                      "風險提示:PalSchema 為社群 mod、僅支援 Windows(native)伺服器,且依賴特定版本的 UE4SS(改版後可能暫時失效);安裝或調整數值前建議先備份存檔。",
                    )}
                  </span>
                </span>
              </DismissibleWarning>
              {status.reason && <p className="mt-2 text-[13px] text-sun">{status.reason}</p>}
            </div>
          )}
        </ModInstallCard>
      </div>

      {!status.schema.installed ? null : (
        <>
          <div className={locked ? "pointer-events-none flex flex-col gap-4 opacity-55" : "flex flex-col gap-4"}>
          <div className={`${card} flex flex-col gap-3`}>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1 text-xs font-bold text-ink-muted">
                {t("帕魯")}
                {gameData ? (
                  <EntityPicker
                    catalog={gameData.pals}
                    iconUrl={palIconUrl}
                    value={palId}
                    onChange={setPalId}
                    placeholder={t("搜尋帕魯名稱或輸入 ID…")}
                  />
                ) : (
                  <input
                    className={inputCls}
                    value={palId}
                    placeholder="Anubis"
                    onChange={(e) => setPalId(e.target.value)}
                  />
                )}
              </label>
              <div className="flex flex-col gap-1 text-xs font-bold text-ink-muted">
                {t("變體")}
                <div className="flex flex-wrap gap-1.5">
                  {PAL_ROW_VARIANTS.map((v) => {
                    const exists =
                      !hasDefaults ||
                      !palId.trim() ||
                      resolveRowCase(defaults, palRowName(palId.trim(), v.id)) in (defaults ?? {});
                    return (
                      <button
                        key={v.id}
                        type="button"
                        className={`rounded-full border-2 px-3 py-1 text-xs font-bold transition ${
                          variant === v.id
                            ? "border-pal bg-pal/10 text-pal"
                            : "border-line text-ink-muted hover:border-pal/50"
                        } ${exists ? "" : "opacity-45"}`}
                        title={exists ? undefined : t("這隻帕魯沒有此變體的資料列(寫入不會生效)")}
                        onClick={() => setVariant(v.id)}
                      >
                        {t(v.label)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            {row && (
              <p className="font-mono text-xs text-ink-muted">
                {t("資料列")}: {row}
              </p>
            )}
            <p className="text-xs text-ink-muted">
              {status.schema.autoReload
                ? t(
                    "改的是物種基礎值,會套用到該物種所有個體;首領(Boss_)/ 高塔首領(GYM_)是獨立資料列,只影響對應版本;已開啟熱重載:儲存後自動套用到新生成/新遭遇的帕魯(若沒生效再重啟)。留空的欄位不會覆寫既有值。",
                  )
                : t(
                    "改的是物種基礎值,會套用到該物種所有個體;首領(Boss_)/ 高塔首領(GYM_)是獨立資料列,只影響對應版本;儲存後要重啟伺服器,才會對新遭遇的帕魯生效。留空的欄位不會覆寫既有值。",
                  )}
            </p>
          </div>

          {palId.trim() ? (
            <>
              {[...grouped.entries()].map(([cat, keys]) => (
                <div key={cat} className={card}>
                  <h3 className="mb-1 text-sm font-extrabold text-ink-muted">
                    {t(PAL_STAT_CATEGORY_LABELS[cat])}
                  </h3>
                  <div className="flex flex-col divide-y divide-line">
                    {keys.map((k) => {
                      const meta: PalStatMeta = PAL_STAT_OPTIONS[k];
                      return (
                        <div key={k} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
                          <div className="min-w-64 flex-1">
                            <p className="text-sm font-bold">{t(meta.label)}</p>
                            <p className="font-mono text-xs text-ink-muted">{meta.key}</p>
                            {meta.hint && (
                              <p className="mt-1 max-w-xl text-xs text-ink-muted">{t(meta.hint)}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5">
                            {([0.5, 2] as const).map((mult) => {
                              const base = draft[k].trim() !== "" ? Number(draft[k]) : original?.[k];
                              const usable = base != null && Number.isFinite(base);
                              return (
                                <button
                                  key={mult}
                                  type="button"
                                  className="rounded-lg border-2 border-line px-1.5 py-1 font-mono text-[11px] font-bold text-ink-muted transition hover:border-pal hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                                  disabled={!usable}
                                  title={t("以目前值(未填則以原版值)為基準套倍率")}
                                  onClick={() => {
                                    if (!usable) return;
                                    const raw = (base as number) * mult;
                                    const v =
                                      meta.type === "int"
                                        ? Math.min(meta.max, Math.max(meta.min, Math.round(raw)))
                                        : Math.min(meta.max, Math.max(meta.min, Number(raw.toFixed(2))));
                                    setDraft((d) => ({ ...d, [k]: String(v) }));
                                  }}
                                >
                                  ×{mult}
                                </button>
                              );
                            })}
                            <input
                              type="number"
                              className={`${inputCls} w-28 text-right`}
                              value={draft[k]}
                              placeholder={original?.[k] != null ? String(original[k]) : t("不覆寫")}
                              title={original?.[k] != null ? t("原版數值:{v}(留空 = 不覆寫)", { v: String(original[k]) }) : undefined}
                              min={meta.min}
                              max={meta.max}
                              step={meta.type === "float" ? (meta.step ?? 0.01) : 1}
                              onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {dirtyKeys.length > 0 && (
                <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-cute border-2 border-sun/50 bg-card p-3 shadow-(--shadow-cute)">
                  <span className="text-[13px] font-bold text-ink-muted">
                    {t("小心~您有 {n} 項變更尚未儲存!(重啟伺服器後生效)", { n: dirtyKeys.length })}
                  </span>
                  <div className="flex gap-2">
                    <button className={btnGhost} onClick={loadDraft} disabled={saving}>
                      {t("重置")}
                    </button>
                    <button className={btn} onClick={save} disabled={saving}>
                      {saving ? t("儲存中…") : t("確定修改")}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-ink-muted">{t("先選一隻帕魯再編輯數值。")}</p>
          )}
        </div>
          {status.rows.length > 0 && (
            <div className={`${card} flex flex-col gap-2`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="inline-flex items-center gap-2 text-sm font-extrabold text-ink-muted">
                  <FiList className="size-4 text-pal" /> {t("已修改的帕魯")}
                  <span className="rounded-full bg-pal/10 px-2 py-0.5 text-xs font-bold text-pal">
                    {status.rows.length}
                  </span>
                </h3>
                <button
                  className={`${btnGhost} inline-flex items-center gap-1.5 text-berry hover:border-berry`}
                  onClick={clearAll}
                  disabled={saving}
                >
                  <FiTrash2 className="size-4" /> {t("刪除所有修改")}
                </button>
              </div>
              <p className="text-xs text-ink-muted">
                {t("這裡列出已寫入 PalSchema 的所有物種數值調整;點「編輯」可載回上方表單修改。")}
              </p>
              <div className="flex flex-col divide-y divide-line">
                {status.rows.map((r) => {
                  const parsed = parseRow(r.row);
                  const pal = gameData?.palById.get(parsed.palId);
                  const vlabel = PAL_ROW_VARIANTS.find((x) => x.id === parsed.variant)?.label;
                  const changed = Object.entries(r.values) as [PalStatKey, number][];
                  return (
                    <div key={r.row} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                      <div className="flex min-w-44 items-center gap-2">
                        {pal?.icon ? (
                          <img src={palIconUrl(pal.icon)} alt="" className="size-7 rounded-md" />
                        ) : (
                          <GiSheep className="size-7 text-ink-muted" />
                        )}
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 truncate text-sm font-bold">
                            {pal ? displayName(pal) : parsed.palId}
                            {parsed.variant !== "normal" && vlabel && (
                              <span className="rounded-full border border-line px-1.5 py-0.5 text-[11px] font-bold text-ink-muted">
                                {t(vlabel)}
                              </span>
                            )}
                          </p>
                          <p className="font-mono text-[11px] text-ink-muted">{r.row}</p>
                        </div>
                      </div>
                      <div className="flex flex-1 flex-wrap gap-1.5">
                        {changed.map(([k, val]) => {
                          const orig = defaults?.[r.row]?.[k];
                          const pct =
                            orig != null && orig !== 0 && orig !== val
                              ? Math.round(((val - orig) / orig) * 100)
                              : null;
                          return (
                            <span
                              key={k}
                              className="rounded-full bg-card-soft px-2 py-0.5 text-[11px] text-ink-muted"
                            >
                              {t(PAL_STAT_OPTIONS[k].label)}{" "}
                              {orig != null && orig !== val && (
                                <>
                                  <span className="font-mono">{orig}</span> →{" "}
                                </>
                              )}
                              <span className="font-mono font-bold text-ink">{val}</span>
                              {pct != null && (
                                <span className={`font-mono font-bold ${pct > 0 ? "text-grass" : "text-berry"}`}>
                                  {" "}{pct > 0 ? "+" : ""}{pct}%
                                </span>
                              )}
                            </span>
                          );
                        })}
                      </div>
                      {!locked && (
                        <button
                          className={`${btnGhost} inline-flex shrink-0 items-center gap-1 text-xs`}
                          onClick={() => {
                            setPalId(parsed.palId);
                            setVariant(parsed.variant);
                          }}
                        >
                          <FiEdit2 className="size-3.5" /> {t("編輯")}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
