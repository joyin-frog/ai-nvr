import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Observer, type CameraSource } from "@/observer/types";

/** 观测记录 */
export interface ObserverRecord {
  id: number;
  /** 观测器 ID */
  observerId: number;
  /** 观测器名称快照 */
  observerName: string;
  /** 摄像头 ID */
  cameraId: string;
  /** 检测时间 */
  timestamp: number;
  /** VLM 分析结果 */
  result: string;
  /** 是否匹配 */
  matched: boolean;
  /** 详细信息 JSON */
  detail: string;
}

/**
 * 观测器存储
 */
export class ObserverStorage {
  private db: Database;
  /** 预编译高频语句 */
  private stmtInsertRecord: ReturnType<Database["prepare"]>;
  private stmtGetEnabled: ReturnType<Database["prepare"]>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA wal_autocheckpoint = 1000");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS observers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        interval_ms INTEGER NOT NULL DEFAULT 5000,
        cooldown_ms INTEGER NOT NULL DEFAULT 30000,
        enabled INTEGER NOT NULL DEFAULT 1,
        image_width INTEGER NOT NULL DEFAULT 0,
        signal_ids TEXT NOT NULL DEFAULT '[]',
        schedule TEXT NOT NULL DEFAULT '',
        save_original INTEGER NOT NULL DEFAULT 1,
        output_regions INTEGER NOT NULL DEFAULT 0,
        cameras_json TEXT NOT NULL DEFAULT '[]',
        ref_images TEXT NOT NULL DEFAULT '[]',
        model_id TEXT NOT NULL DEFAULT ''
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS observer_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observer_id INTEGER NOT NULL,
        observer_name TEXT NOT NULL,
        camera_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        matched INTEGER NOT NULL DEFAULT 0,
        detail TEXT,
        FOREIGN KEY (observer_id) REFERENCES observers(id)
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_observer_records_timestamp ON observer_records(timestamp)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observer_records_observer ON observer_records(observer_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observer_records_camera_time ON observer_records(camera_id, timestamp)");

    /** 从旧 detect_rules 表迁移 */
    this.migrateFromLegacy();

    /** 合并 eval_signal_ids → signal_ids（旧版本升级） */
    this.mergeEvalSignalIds();

    /** 预编译 */
    this.stmtInsertRecord = this.db.prepare(
      "INSERT INTO observer_records (observer_id, observer_name, camera_id, timestamp, result, matched, detail) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
    );
    this.stmtGetEnabled = this.db.prepare(
      `SELECT id, name, prompt, interval_ms as intervalMs, cooldown_ms as cooldownMs, enabled,
        image_width as imageWidth, signal_ids as signalIdsJson,
        schedule, save_original as saveOriginal, output_regions as outputRegions,
        cameras_json as camerasJson, ref_images as refImagesJson, model_id as modelId
      FROM observers WHERE enabled = 1`
    );
  }

  /** 从旧 detect_rules 表迁移数据 */
  private migrateFromLegacy(): void {
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='detect_rules'").all();
    if (tables.length === 0) return;

    /** 检查 observers 表是否为空 */
    const obsCount = (this.db.query("SELECT COUNT(*) as cnt FROM observers").get() as { cnt: number }).cnt;
    if (obsCount > 0) return;

    const legacyRules = this.db.query("SELECT * FROM detect_rules").all() as Array<Record<string, unknown>>;
    for (const row of legacyRules) {
      /** 将旧的 state_ids 转为 signal_ids */
      let signalIds: number[] = [];
      try {
        signalIds = JSON.parse(String(row.state_ids ?? "[]"));
      } catch (e) { console.warn("[ObserverStorage] JSON parse failed for state_ids (legacy migration):", e); }

      let cameras: CameraSource[] = [];
      const camerasJson = String(row.cameras_json ?? "[]");
      if (camerasJson && camerasJson !== "[]") {
        try { cameras = JSON.parse(camerasJson); } catch (e) { console.warn("[ObserverStorage] JSON parse failed for cameras_json (legacy migration):", e); }
      }
      if (cameras.length === 0 && row.camera_id) {
        cameras = [{ cameraId: String(row.camera_id), roiId: Number(row.roi_id ?? 0), offsetSec: 0 }];
      }

      let refImages: string[] = [];
      try { refImages = JSON.parse(String(row.ref_images ?? "[]")); } catch (e) { console.warn("[ObserverStorage] JSON parse failed for ref_images (legacy migration):", e); }

      this.db.run(
        `INSERT OR IGNORE INTO observers (id, name, prompt, interval_ms, cooldown_ms, enabled, image_width, signal_ids, schedule, save_original, output_regions, cameras_json, ref_images, model_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, row.name ?? "", row.prompt ?? "",
          Number(row.interval_ms ?? 5000), Number(row.cooldown_ms ?? 30000),
          Number(row.enabled ?? 1), Number(row.image_width ?? 0),
          JSON.stringify(signalIds),
          String(row.schedule ?? ""), Number(row.save_original ?? 1),
          Number(row.output_regions ?? 0), JSON.stringify(cameras),
          JSON.stringify(refImages), String(row.model_id ?? ""),
        ] as never,
      );
    }

    /** 迁移记录 */
    const legacyRecords = this.db.query("SELECT * FROM detect_rule_records").all() as Array<Record<string, unknown>>;
    for (const row of legacyRecords) {
      this.db.run(
        `INSERT OR IGNORE INTO observer_records (id, observer_id, observer_name, camera_id, timestamp, result, matched, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, row.rule_id ?? 0, row.rule_name ?? "",
          row.camera_id ?? "", Number(row.timestamp ?? 0),
          row.result ?? "", Number(row.matched ?? 0),
          row.detail ?? "",
        ] as never,
      );
    }

    console.log(`[ObserverStorage] 从旧表迁移了 ${legacyRules.length} 个观测器, ${legacyRecords.length} 条记录`);
  }

  /** 合并旧版 eval_signal_ids → signal_ids */
  private mergeEvalSignalIds(): void {
    const col = this.db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='observers'").get() as { sql: string } | undefined;
    if (!col?.sql?.includes("eval_signal_ids")) return;

    /** 读取所有行，合并两个字段 */
    const rows = this.db.query("SELECT id, signal_ids, eval_signal_ids FROM observers").all() as Array<{ id: number; signal_ids: string; eval_signal_ids: string }>;
    for (const row of rows) {
      let signalIds: number[] = [];
      let evalIds: number[] = [];
      try { signalIds = JSON.parse(row.signal_ids); } catch (e) { console.warn("[ObserverStorage] JSON parse failed for signal_ids (mergeEvalSignalIds):", e); }
      try { evalIds = JSON.parse(row.eval_signal_ids); } catch (e) { console.warn("[ObserverStorage] JSON parse failed for eval_signal_ids (mergeEvalSignalIds):", e); }
      const merged = [...new Set([...signalIds, ...evalIds])];
      if (merged.length !== signalIds.length || evalIds.length > 0) {
        this.db.run("UPDATE observers SET signal_ids = ? WHERE id = ?", [JSON.stringify(merged), row.id]);
      }
    }

    /** 删除旧列 */
    this.db.run("ALTER TABLE observers DROP COLUMN eval_signal_ids");
    console.log(`[ObserverStorage] 合并 eval_signal_ids → signal_ids 完成`);
  }

  /** 列出所有观测器 */
  listObservers(): Observer[] {
    return (this.db.query(
      `SELECT id, name, prompt, interval_ms as intervalMs, cooldown_ms as cooldownMs, enabled,
        image_width as imageWidth, signal_ids as signalIdsJson,
        schedule, save_original as saveOriginal, output_regions as outputRegions,
        cameras_json as camerasJson, ref_images as refImagesJson, model_id as modelId
      FROM observers ORDER BY id`
    ).all() as Array<DbRow>).map(this.mapRow);
  }

  /** 获取启用的观测器（预编译） */
  getEnabledObservers(): Observer[] {
    return (this.stmtGetEnabled.all() as Array<DbRow>).map(this.mapRow);
  }

  /** 添加观测器 */
  addObserver(obs: Omit<Observer, "id" | "enabled">): number {
    const row = this.db.query(
      `INSERT INTO observers (name, prompt, interval_ms, cooldown_ms, enabled, image_width, signal_ids, schedule, save_original, output_regions, cameras_json, ref_images, model_id)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).get(
      obs.name, obs.prompt, obs.intervalMs, obs.cooldownMs,
      obs.imageWidth ?? 0, JSON.stringify(obs.signalIds ?? []),
      obs.schedule ?? "", obs.saveOriginal !== false ? 1 : 0,
      obs.outputRegions ? 1 : 0, JSON.stringify(obs.cameras ?? []),
      JSON.stringify(obs.refImages ?? []), obs.modelId ?? "",
    );
    return (row as { id: number }).id;
  }

  /** 更新观测器 */
  updateObserver(id: number, updates: Partial<Omit<Observer, "id">>): boolean {
    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
    if (updates.prompt !== undefined) { sets.push("prompt = ?"); params.push(updates.prompt); }
    if (updates.intervalMs !== undefined) { sets.push("interval_ms = ?"); params.push(updates.intervalMs); }
    if (updates.cooldownMs !== undefined) { sets.push("cooldown_ms = ?"); params.push(updates.cooldownMs); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }
    if (updates.imageWidth !== undefined) { sets.push("image_width = ?"); params.push(updates.imageWidth); }
    if (updates.signalIds !== undefined) { sets.push("signal_ids = ?"); params.push(JSON.stringify(updates.signalIds)); }
    if (updates.schedule !== undefined) { sets.push("schedule = ?"); params.push(updates.schedule); }
    if (updates.saveOriginal !== undefined) { sets.push("save_original = ?"); params.push(updates.saveOriginal ? 1 : 0); }
    if (updates.outputRegions !== undefined) { sets.push("output_regions = ?"); params.push(updates.outputRegions ? 1 : 0); }
    if (updates.refImages !== undefined) { sets.push("ref_images = ?"); params.push(JSON.stringify(updates.refImages)); }
    if (updates.modelId !== undefined) { sets.push("model_id = ?"); params.push(updates.modelId); }
    if (updates.cameras !== undefined) { sets.push("cameras_json = ?"); params.push(JSON.stringify(updates.cameras)); }

    if (sets.length === 0) return false;
    params.push(id);

    const result = this.db.run(
      `UPDATE observers SET ${sets.join(", ")} WHERE id = ?`,
      params,
    );
    return result.changes > 0;
  }

  /** 删除观测器 */
  removeObserver(id: number): boolean {
    this.db.run("DELETE FROM observer_records WHERE observer_id = ?", [id]);
    const result = this.db.run("DELETE FROM observers WHERE id = ?", [id]);
    return result.changes > 0;
  }

  /** 记录检测结果 */
  insertRecord(observerId: number, observerName: string, cameraId: string, timestamp: number, result: string, matched: boolean, detail: string): number {
    const row = this.stmtInsertRecord.get(observerId, observerName, cameraId, timestamp, result, matched ? 1 : 0, detail);
    return (row as { id: number }).id;
  }

  /** 查询检测记录 */
  queryRecords(options: {
    cameraId?: string;
    since?: number;
    until?: number;
    matched?: boolean;
    limit?: number;
    offset?: number;
  } = {}): ObserverRecord[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.cameraId) { conditions.push("camera_id = ?"); params.push(options.cameraId); }
    if (options.since) { conditions.push("timestamp >= ?"); params.push(options.since); }
    if (options.until) { conditions.push("timestamp <= ?"); params.push(options.until); }
    if (options.matched !== undefined) { conditions.push("matched = ?"); params.push(options.matched ? 1 : 0); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    return this.db.query(
      `SELECT id, observer_id as observerId, observer_name as observerName, camera_id as cameraId, timestamp, result, matched, detail FROM observer_records ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as ObserverRecord[];
  }

  /** 查询记录数量 */
  countRecords(options: { cameraId?: string; since?: number; until?: number; matched?: boolean } = {}): number {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.cameraId) { conditions.push("camera_id = ?"); params.push(options.cameraId); }
    if (options.since) { conditions.push("timestamp >= ?"); params.push(options.since); }
    if (options.until) { conditions.push("timestamp <= ?"); params.push(options.until); }
    if (options.matched !== undefined) { conditions.push("matched = ?"); params.push(options.matched ? 1 : 0); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db.query(`SELECT COUNT(*) as count FROM observer_records ${where}`).get(...params) as { count: number };
    return row.count;
  }

  /** 清理过期记录 */
  purge(beforeTimestamp: number): number {
    const result = this.db.run("DELETE FROM observer_records WHERE timestamp < ?", [beforeTimestamp]);
    return result.changes;
  }

  /** 删除所有记录 */
  purgeAll(): number {
    const count = (this.db.query("SELECT COUNT(*) as cnt FROM observer_records").get() as { cnt: number }).cnt;
    this.db.run("DELETE FROM observer_records");
    return count;
  }

  /** 数据库行映射 */
  private mapRow(row: DbRow): Observer {
    let signalIds: number[] = [];
    try { signalIds = JSON.parse(row.signalIdsJson); } catch (e) { console.warn("[ObserverStorage] JSON parse failed for signalIdsJson:", e); }

    let cameras: CameraSource[] = [];
    try { cameras = JSON.parse(row.camerasJson); } catch (e) { console.warn("[ObserverStorage] JSON parse failed for camerasJson:", e); }

    let refImages: string[] = [];
    try { refImages = JSON.parse(row.refImagesJson ?? "[]"); } catch (e) { console.warn("[ObserverStorage] JSON parse failed for refImagesJson:", e); }

    return {
      id: row.id,
      name: row.name,
      cameras,
      prompt: row.prompt,
      intervalMs: row.intervalMs,
      cooldownMs: row.cooldownMs,
      enabled: !!row.enabled,
      imageWidth: row.imageWidth,
      signalIds,
      schedule: row.schedule,
      saveOriginal: !!row.saveOriginal,
      outputRegions: !!row.outputRegions,
      refImages,
      modelId: row.modelId ?? "",
    };
  }

  close(): void {
    this.db.close();
  }
}

/** 数据库原始行类型 */
interface DbRow {
  id: number;
  name: string;
  prompt: string;
  intervalMs: number;
  cooldownMs: number;
  enabled: number;
  imageWidth: number;
  signalIdsJson: string;
  schedule: string;
  saveOriginal: number;
  outputRegions: number;
  camerasJson: string;
  refImagesJson: string;
  modelId: string;
}
