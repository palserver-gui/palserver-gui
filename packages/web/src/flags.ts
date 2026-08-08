/**
 * 前端功能旗標。
 *
 * 贊助者先行版功能(自訂帕魯 / 帕魯蛋 + 贊助者識別碼)尚未對外公布,先把 UI 入口
 * 全部隱藏。要正式公開時把這個改成 true(未來也可改接環境變數 / 遠端設定)即可,
 * 不用動各處元件。後端路由本來就有授權閘門,隱藏入口即足夠。
 */
export const SHOW_SPONSOR_FEATURES = true;

/** 快速傳送全開(存檔解鎖):功能已完成但先隱藏,待 Windows 實機驗證後開放。 */
export const SHOW_FAST_TRAVEL_UNLOCK = false;

/** 頭目重生時間(贊助 feature `boss-respawn`):v2.6.0 起正式對外開放。 */
export const SHOW_BOSS_RESPAWN = true;

/**
 * FORK 추가: 게임 고유명사(주동기·패시브 등)를 한국어로 표시.
 *
 * 이 앱에는 한국어 UI 로케일이 없어서 displayName() 의 언어 분기로는 한국어를 고를 수
 * 없다. 이 플래그가 켜지면 UI 언어와 무관하게 카탈로그의 `ko` 필드를 우선 사용한다
 * (UI 버튼·라벨은 영향 없음). 원래 동작으로 되돌리려면 false 로 바꾸면 된다.
 */
export const PREFER_KOREAN_GAME_NAMES = true;
