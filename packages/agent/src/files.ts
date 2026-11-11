import fs from "node:fs";
import path from "node:path";
import type { DirEntry, FileContent } from "@palserver/shared";
import type { DriverContext } from "./driver.js";
import type { InstanceRecord } from "./store.js";
import { serverRoot } from "./native.js";

/** Text files above this size are refused by the editor (upload/download still work). */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".ini", ".txt", ".json", ".lua", ".cfg", ".conf", ".yaml", ".yml",
  ".md", ".log", ".xml", ".toml", ".csv", ".properties",
]);

function badRequest(message: string, statusCode = 400): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/** The directory an instance's file browser is confined to. */
export function fileRoot(rec: InstanceRecord, ctx: DriverContext): string {
  if (rec.backend === "k8s") {
    throw badRequest("k8s 走 Pod exec 路徑,不應到 fileRoot", 409);
  }
  // docker: bind-mount 把 Pal/Saved 映射到 ${instanceDir}/saved
  // native: 完整伺服器目錄
  const root = rec.backend === "docker"
    ? path.join(ctx.instanceDir, "saved")
    : serverRoot(rec, ctx);
  if (!fs.existsSync(root)) {
    throw badRequest("伺服器尚未安裝 — 先啟動一次讓 agent 下載伺服器", 409);
  }
  return fs.realpathSync(root);
}

/**
 * Resolve a client-supplied relative path inside `root`.
 * Rejects absolute paths, `..` escapes, and symlinks pointing outside the
 * root (checked against the realpath of the deepest existing ancestor, so
 * that creating new files still works).
 */
export function resolveInRoot(root: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw badRequest("路徑不合法");
  }
  const target = path.resolve(root, normalized);

  let existing = target;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) {
    existing = path.dirname(existing);
  }
  const realExisting = fs.realpathSync(existing);
  const suffix = path.relative(existing, target);
  const real = suffix ? path.join(realExisting, suffix) : realExisting;

  if (real !== root && !real.startsWith(root + path.sep)) {
    throw badRequest("路徑不合法");
  }
  return real;
}

export function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function listDir(root: string, relPath: string): DirEntry[] {
  const dir = resolveInRoot(root, relPath);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw badRequest("資料夾不存在", 404);
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const full = path.join(dir, entry.name);
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      return {
        name: entry.name,
        isDir: entry.isDirectory(),
        size: stat?.size ?? 0,
        modifiedAt: stat ? new Date(stat.mtimeMs).toISOString() : "",
        editable: !entry.isDirectory() && isTextFile(entry.name) && (stat?.size ?? 0) <= MAX_EDIT_BYTES,
      } satisfies DirEntry;
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

export function readFile(root: string, relPath: string): FileContent {
  const file = resolveInRoot(root, relPath);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw badRequest("檔案不存在", 404);
  if (!isTextFile(path.basename(file))) throw badRequest("這不是可編輯的文字檔");
  if (stat.size > MAX_EDIT_BYTES) throw badRequest("檔案過大,無法在編輯器中開啟");
  return { path: relPath, content: fs.readFileSync(file, "utf8") };
}

/** Resolve a regular file for binary download without reading it into memory. */
export function downloadFilePath(root: string, relPath: string): string {
  const file = resolveInRoot(root, relPath);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw badRequest("檔案不存在", 404);
  return file;
}

export function writeFile(root: string, relPath: string, content: string): void {
  const file = resolveInRoot(root, relPath);
  if (!isTextFile(path.basename(file))) throw badRequest("只能編輯文字檔");
  if (Buffer.byteLength(content) > MAX_EDIT_BYTES) throw badRequest("內容過大");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function deletePath(root: string, relPath: string): void {
  const target = resolveInRoot(root, relPath);
  if (target === root) throw badRequest("不能刪除伺服器根目錄");
  if (!fs.existsSync(target)) throw badRequest("檔案不存在", 404);
  fs.rmSync(target, { recursive: true, force: true });
}

export function makeDir(root: string, relPath: string): void {
  const dir = resolveInRoot(root, relPath);
  if (fs.existsSync(dir)) throw badRequest("同名項目已存在", 409);
  fs.mkdirSync(dir, { recursive: true });
}

/** Destination for a streamed upload; parent dirs are created. */
export function uploadTarget(root: string, relPath: string): string {
  const file = resolveInRoot(root, relPath);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    throw badRequest("目標是資料夾");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}
