import path from "node:path";
import type { DirEntry, FileContent } from "@palserver/shared";
import type { InstanceRecord } from "./store.js";
import {
  deletePathInPod,
  downloadFileInPod,
  execInPod,
  listDirInPod,
  makeDirInPod,
  readFileInPod,
  resolvePodPath,
  uploadFileInPod,
  writeFileInPod,
} from "./k8s-files.js";

const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".ini", ".txt", ".json", ".lua", ".cfg", ".conf", ".yaml", ".yml",
  ".md", ".log", ".xml", ".toml", ".csv", ".properties",
]);

function badRequest(message: string, statusCode = 400): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function assertTextFile(relPath: string): void {
  if (!TEXT_EXTENSIONS.has(path.posix.extname(relPath).toLowerCase())) {
    throw badRequest("只能編輯文字檔");
  }
}

function assertRelative(relPath: string, allowRoot = true): string {
  const full = resolvePodPath(relPath);
  if (!allowRoot && full === "/palworld") throw badRequest("不能刪除伺服器根目錄");
  return full;
}

async function statInPod(rec: InstanceRecord, fullPath: string): Promise<{ size: number; modifiedAt: string }> {
  const raw = await execInPod(rec, ["stat", "-c", "%s %Y", fullPath]);
  const [size, mtime] = raw.trim().split(/\s+/);
  return {
    size: Number(size) || 0,
    modifiedAt: mtime ? new Date(Number(mtime) * 1000).toISOString() : "",
  };
}

export async function listDirInPodBrowser(rec: InstanceRecord, relPath: string): Promise<DirEntry[]> {
  const full = assertRelative(relPath);
  const names = (await listDirInPod(rec, relPath)).split("\n").map((s) => s.trim()).filter(Boolean);
  const entries: DirEntry[] = [];
  for (const name of names) {
    const childRel = relPath ? `${relPath}/${name}` : name;
    const child = assertRelative(childRel);
    const isDir = await execInPod(rec, ["test", "-d", child]).then(() => true).catch(() => false);
    const stat = await statInPod(rec, child).catch(() => ({ size: 0, modifiedAt: "" }));
    entries.push({
      name,
      isDir,
      size: isDir ? 0 : stat.size,
      modifiedAt: stat.modifiedAt,
      editable: !isDir && TEXT_EXTENSIONS.has(path.posix.extname(name).toLowerCase()) && stat.size <= MAX_EDIT_BYTES,
    });
  }
  void full;
  return entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

export async function readFileInPodBrowser(rec: InstanceRecord, relPath: string): Promise<FileContent> {
  const full = assertRelative(relPath, false);
  assertTextFile(relPath);
  const stat = await statInPod(rec, full);
  if (stat.size > MAX_EDIT_BYTES) throw badRequest("檔案過大,無法在編輯器中開啟");
  return { path: relPath, content: await readFileInPod(rec, relPath) };
}

/** Download raw file bytes after applying the same Pod-root path guard. */
export async function downloadFileInPodBrowser(rec: InstanceRecord, relPath: string): Promise<Buffer> {
  const full = assertRelative(relPath, false);
  const isFile = await execInPod(rec, ["test", "-f", full]).then(() => true).catch(() => false);
  if (!isFile) throw badRequest("檔案不存在", 404);
  return downloadFileInPod(rec, relPath);
}

export async function writeFileInPodBrowser(rec: InstanceRecord, relPath: string, content: string): Promise<void> {
  assertRelative(relPath, false);
  assertTextFile(relPath);
  if (Buffer.byteLength(content, "utf8") > MAX_EDIT_BYTES) throw badRequest("內容過大");
  const parent = path.posix.dirname(relPath);
  if (parent !== ".") await makeDirInPod(rec, parent);
  await writeFileInPod(rec, relPath, content);
}

export async function makeDirInPodBrowser(rec: InstanceRecord, relPath: string): Promise<void> {
  assertRelative(relPath, false);
  await makeDirInPod(rec, relPath);
}

export async function deletePathInPodBrowser(rec: InstanceRecord, relPath: string): Promise<void> {
  assertRelative(relPath, false);
  await deletePathInPod(rec, relPath);
}

export async function uploadFileInPodBrowser(rec: InstanceRecord, relPath: string, content: Uint8Array): Promise<void> {
  assertRelative(relPath, false);
  const parent = path.posix.dirname(relPath);
  if (parent !== ".") await makeDirInPod(rec, parent);
  await uploadFileInPod(rec, relPath, content);
}
