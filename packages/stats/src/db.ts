/**
 * node:sqlite 上的極簡 D1 相容層。
 *
 * 這個服務原本是 Cloudflare Worker + D1,搬到 Zeabur 後改跑 Node + 本機 SQLite 檔;
 * 沿用 D1 的 prepare().bind().first/all/run 與 batch 介面,index.ts 的處理邏輯不用動。
 * SQL 本來就是 SQLite 方言(D1 = SQLite):?1 編號參數、ON CONFLICT ... RETURNING、
 * 部分唯一索引都原樣可用。node:sqlite 是同步 API,單一程序內每條語句天然不互相穿插。
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";

type Value = string | number | null;

export class Statement {
  #stmt: StatementSync;
  #params: Value[];

  constructor(stmt: StatementSync, params: Value[] = []) {
    this.#stmt = stmt;
    this.#params = params;
  }

  bind(...params: Value[]): Statement {
    return new Statement(this.#stmt, params);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.#stmt.get(...this.#params) as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.#stmt.all(...this.#params) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: Number(this.runSync().changes) } };
  }

  /** batch 用:在外層交易裡同步執行。 */
  runSync() {
    return this.#stmt.run(...this.#params);
  }
}

export class Db {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  prepare(sql: string): Statement {
    return new Statement(this.#db.prepare(sql));
  }

  /** 同 D1 batch:全部成功才 commit,任一失敗整批 rollback。 */
  async batch(stmts: Statement[]): Promise<void> {
    this.#db.exec("BEGIN");
    try {
      for (const s of stmts) s.runSync();
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
}
