import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiX } from "react-icons/fi";
import { displayName, type GameEntity } from "./gameData";
import { t, useI18n } from "./i18n";
import { inputCls } from "./ui";

/**
 * 多選搜尋器:在一份目錄(詞條 / 主動技)裡搜尋、選多個,已選以 chip 呈現。
 * 目錄外的原始 id 也能直接加入(遊戲更新後出現的新 id 不會被擋)。
 * renderMeta 讓呼叫端在每列 / chip 補一個小標(等級箭頭、元素色點)。
 */
export function MultiPicker({
  catalog,
  value,
  onChange,
  max,
  placeholder,
  renderMeta,
}: {
  catalog: GameEntity[];
  value: string[];
  onChange: (ids: string[]) => void;
  max: number;
  placeholder?: string;
  renderMeta?: (e: GameEntity) => ReactNode;
}) {
  useI18n();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const chosen = value.map((id) => catalog.find((e) => e.id === id) ?? { id, name: id });
  const full = value.length >= max;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const raw = query.trim();
    const list = catalog.filter((e) => {
      if (value.includes(e.id)) return false;
      if (!q) return true;
      // 五語都比對:en(name)/id 不分大小寫,zh(繁)/zhCN(簡)/ja/ko 原樣包含
      return (
        e.name.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q) ||
        e.zh?.includes(raw) ||
        e["zh-CN"]?.includes(raw) ||
        e.zhCN?.includes(raw) ||
        e.ja?.includes(raw) ||
        e.ko?.includes(raw)
      );
    });
    return list.slice(0, 60);
  }, [catalog, query, value]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const add = (id: string) => {
    const clean = id.trim();
    if (!clean || value.includes(clean) || value.length >= max) return;
    onChange([...value, clean]);
    setQuery("");
    setHighlight(0);
  };
  const remove = (id: string) => onChange(value.filter((v) => v !== id));

  return (
    <div className="relative flex flex-col gap-1.5" ref={boxRef}>
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chosen.map((e) => (
            <span
              key={e.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border-2 border-line bg-card-soft py-0.5 pr-1 pl-2 text-xs"
            >
              {renderMeta?.(e as GameEntity)}
              <span className="truncate font-bold text-ink">{displayName(e as GameEntity)}</span>
              <button
                type="button"
                className="shrink-0 text-ink-muted transition hover:text-berry"
                onClick={() => remove(e.id)}
                aria-label={t("移除")}
              >
                <FiX className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {!full && (
        <>
          <input
            className={inputCls + " w-full"}
            value={query}
            placeholder={placeholder ?? t("搜尋名稱或直接輸入 ID…")}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setHighlight(0);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, matches.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (matches[highlight]) add(matches[highlight].id);
                else if (query.trim()) add(query.trim());
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
          {query.trim() && !catalog.some((e) => e.id === query.trim()) && (
            <button
              type="button"
              className="absolute right-2 bottom-2 text-xs font-bold text-pal"
              onClick={() => add(query.trim())}
            >
              {t("用此 ID")}
            </button>
          )}
          {open && matches.length > 0 && (
            <div className="absolute top-full right-0 left-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-xl border-2 border-line bg-card shadow-(--shadow-cute)">
              {matches.map((entity, i) => (
                <button
                  key={entity.id}
                  type="button"
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition ${
                    i === highlight ? "bg-card-soft" : "hover:bg-card-soft"
                  }`}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => add(entity.id)}
                >
                  {renderMeta?.(entity)}
                  <span className="min-w-0 flex-1 truncate text-sm font-bold">
                    {displayName(entity)}
                  </span>
                  <span className="max-w-[45%] shrink-0 truncate font-mono text-xs text-ink-muted">
                    {entity.id}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {full && (
        <p className="text-xs text-ink-muted">{t("已達上限({n})", { n: max })}</p>
      )}
    </div>
  );
}
