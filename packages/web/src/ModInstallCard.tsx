import { FiCheck, FiDownload, FiPower } from "react-icons/fi";
import { t, useI18n } from "./i18n";
import { btn, btnGhost, card } from "./ui";

/**
 * 模組/外掛的統一安裝卡 —— 與「反作弊插件」分頁的版本卡同一種精簡造型:
 * 左:標題 + 徽章(已安裝/版本);右:按鈕列(安裝或更新 / 測試版 / 移除);
 * 下:整寬的說明與備註。PalDefender、UE4SS、PalSchema 三處共用,
 * 各分頁只提供資料與動作,不各自排版。
 */
export function ModInstallCard({
  title,
  titleExtra,
  desc,
  installed,
  version,
  running,
  requiresStopped = true,
  busy,
  busyLabel,
  onInstall,
  installLabel,
  updateLabel,
  installTitle,
  onInstallBeta,
  enabled,
  onToggleEnabled,
  latestVersion,
  note,
  children,
}: {
  title: string;
  /** 標題右側的額外徽章(例:贊助者星星)。 */
  titleExtra?: React.ReactNode;
  /** 整寬說明文字(顯示在按鈕列下方)。 */
  desc?: string;
  installed: boolean;
  version?: string | null;
  /** 伺服器運作中:安裝/移除類動作停用並提示先停止。 */
  running: boolean;
  /** 操作前提:native 的 DLL 被執行中程序鎖定 → 需先停止(true,預設);
   *  docker/k8s 靠 exec 寫容器/Pod → 反而需要運行中(false),操作後重啟生效。 */
  requiresStopped?: boolean;
  /** 任一動作進行中(停用整排按鈕)。 */
  busy: boolean;
  busyLabel?: string;
  /** 主按鈕:未安裝=安裝穩定版,已安裝=更新到最新版。不給就不顯示。 */
  onInstall?: () => void;
  installLabel?: string;
  updateLabel?: string;
  installTitle?: string;
  /** 測試版按鈕(有 beta 通道的元件才給)。 */
  onInstallBeta?: () => void;
  /** 已安裝時的啟用狀態(false=已停用;undefined=不支援/舊 agent,不顯示)。 */
  enabled?: boolean;
  /** 停用/啟用切換(不刪檔,改名主 DLL)。 */
  onToggleEnabled?: () => void;
  /** 最新穩定版 tag:與 version 不同時顯示「有新版」徽章。 */
  latestVersion?: string | null;
  /** 底部小字備註(desc 之後)。 */
  note?: React.ReactNode;
  /** 追加內容(警告區塊等),整寬顯示在 desc 與 note 之間。 */
  children?: React.ReactNode;
}) {
  useI18n();
  // 鎖定語意依後端分流:native 運行中鎖(DLL 鎖定);docker/k8s 停機鎖(無容器可 exec)。
  // runLocked 是「純運行狀態鎖」(不含 busy)——tooltip 文案只看它,否則 busy 期間
  // (native 安裝中)會誤顯「請先停止伺服器」(違反 native 行為不變紅線)。
  const runLocked = requiresStopped ? running : !running;
  const locked = busy || runLocked;
  const lockTitle = requiresStopped
    ? t("請先停止伺服器")
    : running
      ? t("重啟伺服器後生效")
      : t("請先啟動伺服器");
  return (
    <div className={`${card} flex flex-wrap items-center justify-between gap-3`}>
      <div className="inline-flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-extrabold text-ink-muted">{title}</span>
        {titleExtra}
        {installed && (
          <span className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-grass/40 bg-grass/15 px-3 py-1 text-xs font-bold text-grass">
            <FiCheck className="size-3.5" />
            {t("已安裝")}{version ? ` ${version}` : ""}
          </span>
        )}
        {installed && enabled === false && (
          <span className="rounded-full border-[1.5px] border-line bg-card-soft px-3 py-1 text-xs font-bold text-ink-muted">
            {t("已停用")}
          </span>
        )}
        {installed && version && latestVersion && latestVersion !== version && (
          <span
            className="rounded-full border-[1.5px] border-sun/40 bg-sun/10 px-3 py-1 text-xs font-bold text-sun"
            title={t("改版後模組常需更新才相容;按「更新到最新版」升級")}
          >
            {t("有新版 {v}", { v: latestVersion })}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onInstall && (
          <button
            className={`${btn} inline-flex items-center gap-1.5`}
            onClick={onInstall}
            disabled={locked}
            title={runLocked ? lockTitle : installTitle}
          >
            <FiDownload className="size-4" />
            {busy
              ? busyLabel ?? t("安裝中…")
              : installed
                ? updateLabel ?? t("更新到最新版")
                : installLabel ?? t("安裝穩定版")}
          </button>
        )}
        {onInstallBeta && (
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={onInstallBeta}
            disabled={locked}
            title={runLocked ? lockTitle : t("安裝最新測試版(含較新功能,可能不穩定)")}
          >
            {t("安裝測試版")}
          </button>
        )}
        {installed && onToggleEnabled && (
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={onToggleEnabled}
            disabled={locked}
            title={
              runLocked
                ? lockTitle
                : enabled === false
                  ? t("重新啟用(把 DLL 改回原名)")
                  : t("暫時停用不刪檔:改版後模組不相容時的安全退路,Lua/設定檔都會保留")
            }
          >
            <FiPower className="size-4" />
            {busy ? t("處理中…") : enabled === false ? t("啟用") : t("停用")}
          </button>
        )}

      </div>
      {desc && <p className="w-full text-[13px] text-ink-muted">{desc}</p>}
      {children && <div className="w-full">{children}</div>}
      {note && <p className="w-full text-xs text-ink-muted">{note}</p>}
    </div>
  );
}
