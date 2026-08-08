import { useEffect, useState } from "react";
import { FiStar, FiLock, FiX, FiMapPin, FiSend } from "react-icons/fi";
import { hasFeature, type KnownPlayer } from "@palserver/shared";
import type { AgentClient } from "./api";
import { PlayerPicker } from "./PlayerPicker";
import { MapPickModal } from "./MapPickModal";
import { t, useI18n } from "./i18n";
import { Overlay, btn, btnGhost, card, errorCls, inputCls } from "./ui";

/**
 * 傳送玩家(贊助者先行版 teleport):把某玩家傳送到「另一玩家」或「地圖上描點的座標」。
 * 底層走 PalDefender RCON `tp <來源> <目標玩家|x y z>`,立即生效。
 */
export function TeleportModal({
  client,
  instanceId,
  initialSource,
  initialTargetPlayer,
  onClose,
}: {
  client: AgentClient;
  instanceId: string;
  initialSource?: string;
  /** 預填「傳送目的地=此玩家」(例:操作選單的「傳送到此玩家位置」) */
  initialTargetPlayer?: string;
  onClose: () => void;
}) {
  useI18n();
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [players, setPlayers] = useState<KnownPlayer[]>([]);
  const [source, setSource] = useState(initialSource ?? "");
  const [mode, setMode] = useState<"player" | "coords">("player");
  const [targetPlayer, setTargetPlayer] = useState(initialTargetPlayer ?? "");
  const [coords, setCoords] = useState("");
  const [showMap, setShowMap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("teleport", l)))
      .catch(() => setEntitled(false));
    client.knownPlayers(instanceId).then(setPlayers).catch(() => setPlayers([]));
  }, [client, instanceId]);

  const locked = false;
  const target = (mode === "player" ? targetPlayer : coords).trim();
  const canSubmit = !locked && source.trim() !== "" && target !== "" && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await client.teleport(instanceId, source.trim(), target);
      setResult(res.output || t("已送出"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <div
        className={`${card} flex max-h-[86vh] w-160 max-w-full flex-col gap-3 overflow-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
            <FiSend className="size-5 text-pal" /> {t("傳送玩家")}
            <span className="inline-flex items-center gap-1 rounded-full bg-pal/10 px-2 py-0.5 text-xs font-bold text-pal">
              <FiStar className="size-3" /> {t("贊助者")}
            </span>
          </h2>
          <button className="text-ink-muted transition hover:text-ink" onClick={onClose} aria-label={t("關閉")}>
            <FiX className="size-5" />
          </button>
        </div>

        {locked && (
          <div className="inline-flex items-center gap-2 rounded-cute border-2 border-sun/40 bg-sun/10 px-3 py-2 text-xs font-bold text-sun">
            <FiLock className="size-4 shrink-0" />
            {t("這是贊助者先行版功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}
          </div>
        )}

        <p className="text-xs text-ink-muted">
          {t("把某玩家傳送到另一玩家所在,或地圖上描點的座標(透過 PalDefender),立即生效。")}
        </p>

        <div className={locked ? "pointer-events-none flex flex-col gap-3 opacity-55" : "flex flex-col gap-3"}>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-bold text-ink-muted">
            {t("要傳送的玩家")}
            <PlayerPicker roster={players} value={source} onChange={setSource} />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-bold text-ink-muted">{t("傳送到")}</span>
            <div className="flex gap-1.5">
              {(["player", "coords"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`rounded-full border-2 px-3 py-1 text-xs font-bold transition ${
                    mode === m ? "border-pal bg-pal/10 text-pal" : "border-line text-ink-muted hover:border-pal/50"
                  }`}
                  onClick={() => setMode(m)}
                >
                  {m === "player" ? t("另一玩家") : t("地圖座標")}
                </button>
              ))}
            </div>
            {mode === "player" ? (
              <PlayerPicker roster={players} value={targetPlayer} onChange={setTargetPlayer} />
            ) : (
              <div className="flex items-center gap-2">
                <input
                  className={`${inputCls} min-w-0 flex-1`}
                  value={coords}
                  onChange={(e) => setCoords(e.target.value)}
                  placeholder={t("x y(如 100 200),或在地圖描點")}
                />
                <button
                  type="button"
                  className={`${btnGhost} inline-flex shrink-0 items-center gap-1.5`}
                  onClick={() => setShowMap(true)}
                >
                  <FiMapPin className="size-4" /> {t("地圖描點")}
                </button>
              </div>
            )}
          </div>
        </div>

        {error && <p className={errorCls}>{error}</p>}
        {result && (
          <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{result}</p>
        )}

        <button className={`${btn} inline-flex items-center justify-center gap-1.5`} onClick={submit} disabled={!canSubmit}>
          <FiSend className="size-4" /> {busy ? t("傳送中…") : t("傳送")}
        </button>
      </div>

      {showMap && (
        <MapPickModal
          onClose={() => setShowMap(false)}
          onPick={(c) => {
            setCoords(c);
            setMode("coords");
            setShowMap(false);
          }}
        />
      )}
    </Overlay>
  );
}
