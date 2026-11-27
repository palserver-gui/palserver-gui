import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  setModEnabled,
  disabledName,
  renameCommandArgs,
  enabledFromFiles,
  isPodMissingError,
  podMissingError,
} from "./mods.js";
import type { InstanceRecord } from "./store.js";

let tmp = "";
// runtime=wine → serverPlatform 回 windows,不依賴測試機 OS;native 分支用真檔案驗回歸。
const nativeRec = () =>
  ({ id: "t", backend: "native", runtime: "wine", serverDir: tmp }) as unknown as InstanceRecord;
const ctx = () => ({ instanceDir: path.join(tmp, "inst") });
const win64 = () => path.join(tmp, "Pal", "Binaries", "Win64");

function addDll(name: string) {
  fs.mkdirSync(win64(), { recursive: true });
  fs.writeFileSync(path.join(win64(), name), "stub");
}

describe("setModEnabled native (wine) — 既有行為回歸", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mods-k8s-"));
    addDll("PalDefender.dll");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("停用＝改名加 .palserver-disabled 尾碼,不刪檔", async () => {
    await setModEnabled(nativeRec(), ctx(), "paldefender", false);
    assert.equal(fs.existsSync(path.join(win64(), "PalDefender.dll")), false);
    assert.equal(fs.existsSync(path.join(win64(), "PalDefender.dll.palserver-disabled")), true);
  });
  it("啟用＝還原原名", async () => {
    await setModEnabled(nativeRec(), ctx(), "paldefender", false);
    await setModEnabled(nativeRec(), ctx(), "paldefender", true);
    assert.equal(fs.existsSync(path.join(win64(), "PalDefender.dll")), true);
    assert.equal(fs.existsSync(path.join(win64(), "PalDefender.dll.palserver-disabled")), false);
  });
  it("冪等:已停用再停用、已啟用再啟用皆 no-op 不擲錯", async () => {
    await setModEnabled(nativeRec(), ctx(), "paldefender", false);
    await setModEnabled(nativeRec(), ctx(), "paldefender", false);
    assert.equal(fs.existsSync(path.join(win64(), "PalDefender.dll.palserver-disabled")), true);
    await setModEnabled(nativeRec(), ctx(), "paldefender", true);
    await setModEnabled(nativeRec(), ctx(), "paldefender", true);
    assert.equal(fs.existsSync(path.join(win64(), "PalDefender.dll")), true);
  });
});

describe("setModEnabled async 契約（k8s/docker 不假成功的前提）", () => {
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  it("回傳 Promise（k8s 分支內部 exec 為非同步,呼叫點必須 await）", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mods-k8s-"));
    addDll("PalDefender.dll");
    const p = setModEnabled(nativeRec(), ctx(), "paldefender", false);
    assert.ok(p instanceof Promise, "setModEnabled 必須是 async 函式");
    return p;
  });
  it("routes.ts 呼叫點帶 await（缺 await＝路由先回成功、mv 幕後執行＝假成功）", () => {
    const routes = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "routes.ts"),
      "utf8",
    );
    assert.match(routes, /await\s+setModEnabled/);
  });
});

describe("renameCommandArgs — k8s/docker 共用的 mv argv", () => {
  it("停用：mv 原名 → 改名態（Pod 內絕對路徑）", () => {
    assert.deepEqual(renameCommandArgs("Pal/Binaries/Win64/PalDefender.dll", false), [
      "mv",
      "/palworld/Pal/Binaries/Win64/PalDefender.dll",
      "/palworld/Pal/Binaries/Win64/PalDefender.dll.palserver-disabled",
    ]);
  });
  it("啟用：反向還原", () => {
    assert.deepEqual(renameCommandArgs("Pal/Binaries/Win64/PalDefender.dll", true), [
      "mv",
      "/palworld/Pal/Binaries/Win64/PalDefender.dll.palserver-disabled",
      "/palworld/Pal/Binaries/Win64/PalDefender.dll",
    ]);
  });
  it("disabledName 只加尾碼一次", () => {
    assert.equal(disabledName("PalDefender.dll"), "PalDefender.dll.palserver-disabled");
  });
});

describe("enabledFromFiles — status 的 enabled 兩態計算", () => {
  it("active 存在 → true（無論 disabled 殘留與否,與 native componentState 同構）", () => {
    assert.equal(enabledFromFiles(true, false), true);
    assert.equal(enabledFromFiles(true, true), true);
  });
  it("僅 disabled → false；兩者皆無 → 未安裝(null)", () => {
    assert.equal(enabledFromFiles(false, true), false);
    assert.equal(enabledFromFiles(false, false), null);
  });
});

describe("Pod 缺席錯誤 — 409 人話轉譯", () => {
  it("isPodMissingError 認得 podOf 的「找不到運行中的 game-server Pod」", () => {
    assert.equal(isPodMissingError(new Error("找不到運行中的 game-server Pod")), true);
    assert.equal(isPodMissingError(new Error("exec failed: status=1")), false);
    assert.equal(isPodMissingError("not an error"), false);
  });
  it("isPodMissingError 認得 docker 停止容器態(docker-modem 409 訊息)", () => {
    const stopped = Object.assign(
      new Error("(HTTP code 409) container stopped/paused - Container abc123 is not running"),
      { statusCode: 409 },
    );
    assert.equal(isPodMissingError(stopped), true);
    // 無 statusCode 的普通 exec 失敗不得誤判為缺席
    assert.equal(isPodMissingError(new Error("容器內命令失敗(exit 1):mv: can't rename")), false);
  });
  it("podMissingError 帶 409 與「請先啟動伺服器」語意（k8s/docker 措辭）", () => {
    const k = podMissingError("k8s") as Error & { statusCode?: number };
    const d = podMissingError("docker") as Error & { statusCode?: number };
    assert.equal(k.statusCode, 409);
    assert.match(k.message, /啟動/);
    assert.equal(d.statusCode, 409);
    assert.match(d.message, /啟動/);
  });
});
