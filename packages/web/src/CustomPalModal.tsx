import { useEffect, useMemo, useState } from "react";
import { FiStar, FiLock, FiX, FiExternalLink, FiRefreshCw } from "react-icons/fi";
import { GiEggClutch } from "react-icons/gi";
import { hasFeature, type CustomPalInput, type KnownPlayer } from "@palserver/shared";
import type { AgentClient } from "./api";
import { EntityPicker } from "./EntityPicker";
import { MultiPicker } from "./MultiPicker";
import { PlayerPicker } from "./PlayerPicker";
import { useGameData, palIconUrl, itemIconUrl, type GameEntity } from "./gameData";
import { t, useI18n } from "./i18n";
import { Overlay, btn, card, errorCls, inputCls } from "./ui";

/** 主動技元素配色(沒對到的就用中性灰)。 */
const ELEMENT_COLOR: Record<string, string> = {
  Normal: "#b8b8b8",
  Fire: "#ef6a6a",
  Water: "#5aa9e6",
  Electricity: "#e8c34a",
  Grass: "#6fbf73",
  Dark: "#8a6fbf",
  Dragon: "#a06fbf",
  Ground: "#c08a5a",
  Ice: "#6fd0d6",
};

/** chip / 選單列前面的小標:主動技=元素色點,詞條=等級徽章。 */
const skillMeta = (e: GameEntity) => (
  <span
    className="size-2.5 shrink-0 rounded-full"
    style={{ background: ELEMENT_COLOR[e.element ?? "Normal"] ?? "#b8b8b8" }}
    title={e.element}
  />
);
const passiveMeta = (e: GameEntity) => {
  if (e.rank == null) return null;
  const bad = e.rank < 0;
  return (
    <span
      className={`shrink-0 rounded px-1 text-[10px] font-bold ${bad ? "bg-berry/15 text-berry" : "bg-grass/15 text-grass"}`}
    >
      {bad ? e.rank : `+${e.rank}`}
    </span>
  );
};

/** 數字輸入:空字串 -> undefined(交給 PalDefender 預設)。 */
function numOrUndef(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 自訂帕魯彈窗(贊助者先行版 custom-pal):詞條 / 體質 / 星星 / 靈魂 → PalDefender givepal_j。
 * 未解鎖時整個表單照樣顯示,但變灰、不可操作(右側不讓使用),並提示去設定頁輸入識別碼。
 */
export function CustomPalModal({
  client,
  instanceId,
  mode,
  initialUserId,
  onClose,
}: {
  client: AgentClient;
  instanceId: string;
  /** pal = givepal_j(給玩家);egg = giveegg_j(給帕魯蛋)。由開啟的那條指令決定。 */
  mode: "pal" | "egg";
  /** 預填目標玩家(從玩家詳情「玩家操作」跳來時帶入)。 */
  initialUserId?: string;
  onClose: () => void;
}) {
  useI18n();
  const gameData = useGameData();
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [players, setPlayers] = useState<KnownPlayer[]>([]);

  const [userId, setUserId] = useState(initialUserId ?? "");
  const [eggId, setEggId] = useState("");
  const [palId, setPalId] = useState("");
  // BOSS(頭目)變體:送出時給 palId 加 BOSS_ 前綴(僅 pal 模式;蛋孵 BOSS 行為未驗證,不開放)
  const [boss, setBoss] = useState(false);
  const [nickname, setNickname] = useState("");
  const [gender, setGender] = useState<"" | "None" | "Male" | "Female">("");
  const [level, setLevel] = useState("");
  const [stars, setStars] = useState("");
  const [passives, setPassives] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [iv, setIv] = useState({ health: "", attackMelee: "", attackShot: "", defense: "" });
  const [souls, setSouls] = useState({ health: "", attack: "", defense: "", craftSpeed: "" });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("custom-pal", l)))
      .catch(() => setEntitled(false));
    client.knownPlayers(instanceId).then(setPlayers).catch(() => setPlayers([]));
  }, [client, instanceId]);

  /* 隨機填入 helper */
  const randomGender = () => setGender(Math.random() < 0.5 ? "Male" : "Female");
  const randomPassives = () => {
    if (!gameData?.passives?.length) return;
    const n = Math.floor(Math.random() * 9); // 0 ~ 8,與詞條欄位上限一致
    const shuffled = [...gameData.passives].sort(() => Math.random() - 0.5);
    setPassives(shuffled.slice(0, n).map((p) => p.id));
  };
  const randomIvs = () =>
    setIv({
      health: String(Math.floor(Math.random() * 101)),
      attackMelee: String(Math.floor(Math.random() * 101)),
      attackShot: String(Math.floor(Math.random() * 101)),
      defense: String(Math.floor(Math.random() * 101)),
    });

  const locked = false;
  const canSubmit = useMemo(
    () =>
      !locked &&
      palId.trim() !== "" &&
      userId.trim() !== "" &&
      (mode !== "egg" || eggId.trim() !== "") &&
      !busy,
    [locked, mode, eggId, userId, palId, busy],
  );

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const input: CustomPalInput = {
      mode,
      palId:
        boss && mode === "pal" && !palId.trim().startsWith("BOSS_")
          ? `BOSS_${palId.trim()}`
          : palId.trim(),
      userId: userId.trim(),
      ...(mode === "egg" ? { eggId: eggId.trim() } : {}),
      ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
      ...(gender ? { gender } : {}),
      ...(numOrUndef(level) != null ? { level: numOrUndef(level) } : {}),
      ...(numOrUndef(stars) != null ? { condensedPals: numOrUndef(stars) } : {}),
      ...(passives.length ? { passives: passives.slice(0, 8) } : {}),
      ...(skills.length ? { activeSkills: skills.slice(0, 3) } : {}),
      ivs: {
        health: numOrUndef(iv.health),
        attackMelee: numOrUndef(iv.attackMelee),
        attackShot: numOrUndef(iv.attackShot),
        defense: numOrUndef(iv.defense),
      },
      souls: {
        health: numOrUndef(souls.health),
        attack: numOrUndef(souls.attack),
        defense: numOrUndef(souls.defense),
        craftSpeed: numOrUndef(souls.craftSpeed),
      },
    };
    try {
      const r = await client.giveCustomPal(instanceId, input);
      setResult(r.output || t("已送出"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const numField = (label: string, value: string, onChange: (v: string) => void, max: number) => (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-bold text-ink-muted">
      {label}
      <input
        className={inputCls}
        type="number"
        min={0}
        max={max}
        value={value}
        placeholder="—"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );

  return (
    <Overlay onClose={onClose}>
      <div
        className={`${card} flex max-h-[86vh] w-160 max-w-full flex-col gap-3 overflow-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
            <GiEggClutch className="size-5 text-pal" />{" "}
            {mode === "egg" ? t("自訂帕魯蛋") : t("自訂帕魯")}
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
          {t("透過 PalDefender 發一隻客製帕魯給玩家。留空的欄位會用預設。ID 可在")}{" "}
          <a className="text-pal" href="https://paldb.cc" target="_blank" rel="noreferrer">
            paldb.cc <FiExternalLink className="inline size-3" />
          </a>{" "}
          {t("查。")}
        </p>

        {/* 表單:未解鎖時整組變灰、不可操作 */}
        <div className={locked ? "pointer-events-none flex flex-col gap-3 opacity-55" : "flex flex-col gap-3"}>
          <div className="grid gap-2 sm:grid-cols-2">
            {/* 兩種模式都要指定玩家(egg 走 REST /give/paleggs/{userId})。 */}
            <label className="flex min-w-0 flex-col gap-1 text-xs font-bold text-ink-muted">
              {t("目標玩家")}
              <PlayerPicker roster={players} value={userId} onChange={setUserId} />
            </label>
            {mode === "egg" && (
              <label className="flex min-w-0 flex-col gap-1 text-xs font-bold text-ink-muted">
                {t("蛋 ID")}
                {gameData ? (
                  <EntityPicker
                    catalog={gameData.eggs}
                    iconUrl={itemIconUrl}
                    value={eggId}
                    onChange={setEggId}
                    placeholder={t("搜尋蛋名稱或輸入 ID…")}
                  />
                ) : (
                  <input
                    className={inputCls}
                    value={eggId}
                    placeholder="PalEgg_Ice_01"
                    onChange={(e) => setEggId(e.target.value)}
                  />
                )}
              </label>
            )}
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
                <input className={inputCls} value={palId} placeholder="Anubis" onChange={(e) => setPalId(e.target.value)} />
              )}
            </label>
            {mode === "pal" && (
              <label className="flex w-fit cursor-pointer items-center gap-1.5 text-xs font-bold text-ink-muted">
                <input
                  type="checkbox"
                  className="size-4 accent-pal"
                  checked={boss}
                  onChange={(e) => setBoss(e.target.checked)}
                />
                {t("BOSS(頭目)版本")}
              </label>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-4">
            <label className="flex min-w-0 flex-col gap-1 text-xs font-bold text-ink-muted sm:col-span-2">
              {t("暱稱")}
              <input className={inputCls} value={nickname} onChange={(e) => setNickname(e.target.value)} />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs font-bold text-ink-muted">
              <span className="inline-flex items-center gap-1">
                {t("性別")}
                <button type="button" className="inline-flex items-center text-pal transition hover:text-pal/70" onClick={randomGender} title={t("隨機")}>
                  <FiRefreshCw className="size-3" />
                </button>
              </span>
              <select className={inputCls} value={gender} onChange={(e) => setGender(e.target.value as typeof gender)}>
                <option value="">{t("預設")}</option>
                <option value="None">None</option>
                <option value="Male">{t("公")}</option>
                <option value="Female">{t("母")}</option>
              </select>
            </label>
            {numField(t("等級"), level, setLevel, 255)}
          </div>

          <div className="flex min-w-0 flex-col gap-1 text-xs font-bold text-ink-muted">
            <span className="inline-flex items-center gap-1">
              {t("詞條 / 被動(最多 8)")}
              <button type="button" className="inline-flex items-center text-pal transition hover:text-pal/70" onClick={randomPassives} title={t("隨機")}>
                <FiRefreshCw className="size-3" />
              </button>
            </span>
            <MultiPicker
              catalog={gameData?.passives ?? []}
              value={passives}
              onChange={setPassives}
              max={8}
              placeholder={t("搜尋詞條名稱或輸入 ID…")}
              renderMeta={passiveMeta}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1 text-xs font-bold text-ink-muted">
            {t("主動技(最多 3)")}
            <MultiPicker
              catalog={gameData?.activeSkills ?? []}
              value={skills}
              onChange={setSkills}
              max={3}
              placeholder={t("搜尋主動技名稱或輸入 ID…")}
              renderMeta={skillMeta}
            />
          </div>

          <div>
            <p className="mb-1 inline-flex items-center gap-1 text-xs font-bold text-ink-muted">
              {t("體質 / IV(0–255)")}
              <button type="button" className="inline-flex items-center text-pal transition hover:text-pal/70" onClick={randomIvs} title={t("隨機")}>
                <FiRefreshCw className="size-3" />
              </button>
            </p>
            <div className="grid gap-2 sm:grid-cols-4">
              {numField(t("血量"), iv.health, (v) => setIv({ ...iv, health: v }), 255)}
              {numField(t("近攻"), iv.attackMelee, (v) => setIv({ ...iv, attackMelee: v }), 255)}
              {numField(t("遠攻"), iv.attackShot, (v) => setIv({ ...iv, attackShot: v }), 255)}
              {numField(t("防禦"), iv.defense, (v) => setIv({ ...iv, defense: v }), 255)}
            </div>
          </div>

          <div>
            <div className="mb-1 grid gap-2 sm:grid-cols-5">
              <label className="flex min-w-0 flex-col gap-1 text-xs font-bold text-ink-muted">
                {t("濃縮隻數")}
                <input
                  className={inputCls}
                  type="number"
                  min={0}
                  max={48}
                  value={stars}
                  placeholder="—"
                  onChange={(e) => setStars(e.target.value)}
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[
                { stars: 0, count: 0, label: "☆0" },
                { stars: 1, count: 4, label: "☆1" },
                { stars: 2, count: 12, label: "☆2" },
                { stars: 3, count: 24, label: "☆3" },
                { stars: 4, count: 48, label: "☆4" },
              ].map((s) => (
                <button
                  key={s.stars}
                  type="button"
                  className={`rounded-full border-2 px-3 py-1 text-xs font-bold transition ${
                    Number(stars) === s.count
                      ? "border-pal bg-pal text-white"
                      : "border-line bg-card-soft text-ink hover:border-pal"
                  }`}
                  onClick={() => setStars(String(s.count))}
                >
                  <FiStar className={`mr-1 inline size-3 ${s.stars === 0 ? "opacity-30" : ""}`} />
                  {s.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">
              {t("按星等快速填入累積濃縮數量，也可直接手動輸入。")}
            </p>
          </div>

          <div>
            <p className="mb-1 text-xs font-bold text-ink-muted">{t("靈魂強化(0–20)")}</p>
            <div className="grid gap-2 sm:grid-cols-4">
              {numField(t("血量"), souls.health, (v) => setSouls({ ...souls, health: v }), 20)}
              {numField(t("攻擊"), souls.attack, (v) => setSouls({ ...souls, attack: v }), 20)}
              {numField(t("防禦"), souls.defense, (v) => setSouls({ ...souls, defense: v }), 20)}
              {numField(t("製作速度"), souls.craftSpeed, (v) => setSouls({ ...souls, craftSpeed: v }), 20)}
            </div>
          </div>
        </div>

        {error && <p className={errorCls}>{error}</p>}
        {result && <p className="rounded-xl bg-grass/10 px-3 py-2 font-mono text-xs text-grass">{result}</p>}

        <button
          className={`${btn} inline-flex w-fit shrink-0 items-center gap-1.5`}
          onClick={submit}
          disabled={!canSubmit}
        >
          <GiEggClutch className="size-4" />{" "}
          {busy ? t("發送中…") : mode === "egg" ? t("給予帕魯蛋") : t("給予帕魯")}
        </button>
      </div>
    </Overlay>
  );
}
