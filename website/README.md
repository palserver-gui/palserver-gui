# palserver GUI 官網(Next.js 靜態站, 三語 i18n)

React(Next.js App Router)撰寫、`next build` 直接匯出純靜態 HTML 到 `out/`,可部署到 Zeabur、Vercel、Netlify、GitHub Pages 或任何靜態主機。

支援 **繁中 / English / 日本語** 三語:每個語言各自預先渲染成獨立、可被搜尋引擎索引的頁面(`/zh/`、`/en/`、`/ja/`),附 `<html lang>`、canonical 與 hreflang;`/` 會依瀏覽器語言自動導向。

```
website/
├─ app/
│  ├─ [lang]/
│  │  ├─ layout.tsx  每語系 SEO metadata + hreflang + JSON-LD + <html lang>
│  │  └─ page.tsx    載入字典、組裝頁面 + FAQ JSON-LD
│  ├─ globals.css    全站樣式(含 RWD、深淺色、語言切換器)
│  ├─ icon.svg       favicon
│  ├─ robots.ts      → /robots.txt
│  └─ sitemap.ts     → /sitemap.xml(列出三語 + hreflang)
├─ i18n/
│  ├─ config.ts      語系清單、預設語言、hreflang 對應
│  └─ dictionaries.ts 全站文案的 zh / en / ja 字典(型別統一)
├─ components/       各區塊元件(吃字典切片 props);LangSwitch = 語言切換
├─ public/
│  ├─ index.html     「/」語言偵測導向頁(靜態主機用)
│  └─ assets/        截圖與 io software logo
├─ next.config.mjs   output: 'export' + trailingSlash(產出 /zh/index.html)
└─ zbpack.json       Zeabur 雲端(zbpack)用:npm run build → out/(正式站改用 railpack,見「部署」)
```

## 加/改語言與文案

- 改文案:編輯 `i18n/dictionaries.ts` 裡對應語系的字串(`Dictionary` 型別確保三語結構一致, 少翻會編譯報錯)。
- 加語言:在 `i18n/config.ts` 的 `locales` 加代碼、補 `htmlLang`/`ogLocale`/`localeName`,再於 `dictionaries.ts` 補該語系整份字典即可(路由 `generateStaticParams` 會自動產出新頁)。
- 截圖:目前三語共用 `public/assets/*.jpg`(UI 為繁中),但 **alt 文字與視窗標題已隨語言翻譯**。要讓截圖本身也換成英/日 UI, 補上該語系的實際截圖後, 讓元件依 `lang` 取用即可。

## 本機開發

```sh
cd website
npm install
npm run dev        # http://localhost:3000
```

## 建置與預覽

```sh
npm run build      # 產出 out/(純靜態,無需 Node 伺服器)
npm run preview    # 用靜態伺服器預覽 out/
```

## 部署(Mac 上的自架 Zeabur)

正式站 `palserver-gui.iosoftware.ai` 跑在 Mac mini 上的自架 Zeabur 開源版(管理介面只有 Tailscale 裝置開得到),
是專案(namespace)`palserver-stats` 裡的 `website` 服務,跟統計後端 `packages/stats` 同一個專案:

1. Build 用 **railpack**,contextDir `website`,跟 `production` 分支。Build 的環境變數
   `RAILPACK_SPA_OUTPUT_DIR=out` 讓它把 `out/` 當**靜態站** serve(`zbpack.json` 是 Zeabur 雲端的設定,這裡用不到)。
2. 網域 `palserver-gui.iosoftware.ai`(SEO canonical 已指向此網域):Cloudflare DNS 是指向 Cloudflare Tunnel
   的 CNAME(Proxied),源站沒有公開 IP。
3. 沒有資料(內容都在 git);壞了就回滾(Zeabur 介面 → 服務 → 重新啟動與回滾)或 revert。

## SEO 清單(已內建)

- 預先渲染的完整 HTML(靜態匯出, 爬蟲無需執行 JS)
- title / meta description / keywords / canonical
- Open Graph + Twitter Card(以 `assets/overview.jpg` 為分享縮圖)
- JSON-LD 結構化資料:SoftwareApplication、Organization、WebSite、FAQPage
- `robots.txt` + `sitemap.xml` 自動產生
- 圖片皆有 `alt` 與寬高(避免 CLS),hero 圖 preload、其餘 lazy load
- `lang="zh-Hant"`、`theme-color` 深淺色、RWD 手機優化

## 更新內容

- 文案/SEO 文字:改 `i18n/dictionaries.ts`(含各區塊文字、`meta.title`/`meta.description`)。
- 版面/結構:改 `components/` 下對應元件(文字一律走 props,不要寫死)。
- 截圖:放 `public/assets/`,在元件裡以 `/assets/xxx.jpg` 引用(記得填實際寬高)。

改完 push(或合併 PR)到 `main`:GitHub Actions 的 `CI` 全部通過後,`promote` job 把 `production` 分支
快轉到該 commit,Mac 上的 Builder 約 1 分鐘內自動重新建置、Keel 換上新版。CI 沒過就不會上線。
