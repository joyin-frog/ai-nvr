import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 规则摄像头源配置 */
export interface RuleCameraSource {
  /** 摄像头 ID */
  cameraId: string;
  /** 裁剪区域 ID（0=不裁剪，发送完整画面） */
  roiId: number;
  /** 取多少秒前的帧（0=当前帧） */
  offsetSec: number;
  /** 视频片段配置（存在时从录制文件抽帧，而非取单帧） */
  videoClip?: {
    /** 开始偏移秒数（正值=过去，如 30=触发前30秒） */
    startOffsetSec: number;
    /** 结束偏移秒数（如 5=触发前5秒） */
    endOffsetSec: number;
    /** 抽帧配置 */
    extraction: {
      /** 模式：fps=按帧率抽帧，total=均匀抽指定总数 */
      mode: "fps" | "total";
      /** fps 模式时每秒帧数（1-5） */
      fps?: number;
      /** total 模式时总帧数（1-20） */
      totalFrames?: number;
    };
  };
}

/** 检测规则 */
export interface DetectRule {
  id: number;
  /** 规则名称 */
  name: string;
  /** 摄像头列表（至少一个，第一个为主摄像头，决定检测触发时机） */
  cameras: RuleCameraSource[];
  /** 用户提示词 */
  prompt: string;
  /** 检测间隔（毫秒） */
  intervalMs: number;
  /** 冷却时间（毫秒） */
  cooldownMs: number;
  /** 是否启用 */
  enabled: boolean;
  /** AI 推理分辨率（0=使用全局配置） */
  imageWidth: number;
  /** 关联的状态 ID 列表 */
  stateIds: number[];
  /** 时段配置 JSON（空字符串=始终启用） */
  schedule: string;
  /** 匹配时是否保存原图 */
  saveOriginal: boolean;
  /** 指定使用的模型 ID（空字符串=使用默认模型） */
  modelId: string;
  /** 是否输出目标区域坐标 */
  outputRegions: boolean;
  /** 参考图片路径列表（存储在 dataDir/ref-images/ 下） */
  refImages: string[];
}

/** 数据库原始行类型（含 JSON 列） */
interface DbRow {
  id: number;
  cameraId: string;
  roiId: number;
  prompt: string;
  intervalMs: number;
  cooldownMs: number;
  enabled: number;
  imageWidth: number;
  stateIdsJson: string;
  schedule: string;
  saveOriginal: number;
  outputRegions: number;
  camerasJson: string;
  name: string;
  refImagesJson: string;
  modelId: string;
}

/** 检测规则匹配记录 */
export interface DetectRuleRecord {
  id: number;
  /** 规则 ID */
  ruleId: number;
  /** 规则名称快照 */
  ruleName: string;
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
 * 检测规则存储
 */
export class DetectRuleStorage {
  private db: Database;
  /** 预编译高频语句 */
  private stmtInsertRecord: ReturnType<Database["prepare"]>;
  private stmtGetEnabledRules: ReturnType<Database["prepare"]>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA wal_autocheckpoint = 1000");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS detect_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        camera_id TEXT NOT NULL,
        roi_id INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        interval_ms INTEGER NOT NULL DEFAULT 5000,
        cooldown_ms INTEGER NOT NULL DEFAULT 30000,
        enabled INTEGER NOT NULL DEFAULT 1
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS detect_rule_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL,
        rule_name TEXT NOT NULL,
        camera_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        matched INTEGER NOT NULL DEFAULT 0,
        detail TEXT,
        FOREIGN KEY (rule_id) REFERENCES detect_rules(id)
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_detect_rule_records_timestamp ON detect_rule_records(timestamp)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_detect_rule_records_rule ON detect_rule_records(rule_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_detect_rule_records_camera_time ON detect_rule_records(camera_id, timestamp)");

    /** 迁移：添加扩展列 */
    this.migrate();

    /** 预编译高频 SQL（避免每次调用重新解析） */
    this.stmtInsertRecord = this.db.prepare(
      "INSERT INTO detect_rule_records (rule_id, rule_name, camera_id, timestamp, result, matched, detail) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
    );
    this.stmtGetEnabledRules = this.db.prepare(
      `SELECT id, name, camera_id as cameraId, roi_id as roiId, prompt,
        interval_ms as intervalMs, cooldown_ms as cooldownMs, enabled,
        image_width as imageWidth, state_ids as stateIdsJson,
        schedule, save_original as saveOriginal, output_regions as outputRegions,
        cameras_json as camerasJson, ref_images as refImagesJson, model_id as modelId
      FROM detect_rules WHERE enabled = 1`
    );
  }

  /** 检测并添加新列（兼容已有数据库） */
  private migrate(): void {
    const columns = new Set(
      (this.db.query("PRAGMA table_info(detect_rules)").all() as { name: string }[])
        .map(c => c.name)
    );
    if (!columns.has("image_width")) {
      this.db.run("ALTER TABLE detect_rules ADD COLUMN image_width INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.has("state_ids")) {
      this.db.run("ALTER TABLE detect_rules ADD COLUMN state_ids TEXT NOT NULL DEFAULT '[]'");
    }
    if (!columns.has("schedule")) {
      this.db.run("ALTER TABLE detect_rules ADD COLUMN schedule TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.has("save_original")) {
      this.db.run("ALTER TABLE detect_rules ADD COLUMN save_original INTEGER NOT NULL DEFAULT 1");
    }
    if (!columns.has("output_regions")) {
      this.db.run("ALTER TABLE detect_rules ADD COLUMN output_regions INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.has("cameras_json")) {
      this.db.run("ALTER TABLE detect_rules ADD COLUMN cameras_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!columns.has("ref_images")) {
      this.db.run("ALTER TABLE detect_rules ADD COLUMN ref_images TEXT NOT NULL DEFAULT '[]'");
    }
    if (!columns.has("model_id")) {
      this.db.run("ALTER TABLE detect_rules ADD COLUMN model_id TEXT NOT NULL DEFAULT ''");
    }
  }

  /** 列出所有规则 */
  listRules(): DetectRule[] {
    return (this.db.query(
      `SELECT id, name, camera_id as cameraId, roi_id as roiId, prompt,
        interval_ms as intervalMs, cooldown_ms as cooldownMs, enabled,
        image_width as imageWidth, state_ids as stateIdsJson,
        schedule, save_original as saveOriginal, output_regions as outputRegions,
        cameras_json as camerasJson, ref_images as refImagesJson, model_id as modelId
      FROM detect_rules ORDER BY id`
    ).all() as Array<DbRow>).map(this.mapRule);
  }

  /** 获取启用的规则（预编译查询） */
  getEnabledRules(): DetectRule[] {
    return (this.stmtGetEnabledRules.all() as Array<DbRow>).map(this.mapRule);
  }

  /** 添加规则 */
  addRule(rule: Omit<DetectRule, "id" | "enabled">): number {
    const stateIdsJson = JSON.stringify(rule.stateIds ?? []);
    const camerasJson = JSON.stringify(rule.cameras ?? []);
    const refImagesJson = JSON.stringify(rule.refImages ?? []);
    /** 兼容旧列：取第一个摄像头作为主摄像头 */
    const primaryCam = rule.cameras[0];
    const row = this.db.query(
      `INSERT INTO detect_rules (name, camera_id, roi_id, prompt, interval_ms, cooldown_ms, enabled, image_width, state_ids, schedule, save_original, output_regions, cameras_json, ref_images)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).get(
      rule.name, primaryCam?.cameraId ?? "", primaryCam?.roiId ?? 0, rule.prompt,
      rule.intervalMs, rule.cooldownMs,
      rule.imageWidth ?? 0, stateIdsJson, rule.schedule ?? "",
      rule.saveOriginal !== false ? 1 : 0,
      rule.outputRegions ? 1 : 0,
      camerasJson, refImagesJson,
    );
    return (row as { id: number }).id;
  }

  /** 更新规则 */
  updateRule(id: number, updates: Partial<Omit<DetectRule, "id">>): boolean {
    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
    if (updates.prompt !== undefined) { sets.push("prompt = ?"); params.push(updates.prompt); }
    if (updates.intervalMs !== undefined) { sets.push("interval_ms = ?"); params.push(updates.intervalMs); }
    if (updates.cooldownMs !== undefined) { sets.push("cooldown_ms = ?"); params.push(updates.cooldownMs); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }
    if (updates.imageWidth !== undefined) { sets.push("image_width = ?"); params.push(updates.imageWidth); }
    if (updates.stateIds !== undefined) { sets.push("state_ids = ?"); params.push(JSON.stringify(updates.stateIds)); }
    if (updates.schedule !== undefined) { sets.push("schedule = ?"); params.push(updates.schedule); }
    if (updates.saveOriginal !== undefined) { sets.push("save_original = ?"); params.push(updates.saveOriginal ? 1 : 0); }
    if (updates.outputRegions !== undefined) { sets.push("output_regions = ?"); params.push(updates.outputRegions ? 1 : 0); }
    if (updates.refImages !== undefined) { sets.push("ref_images = ?"); params.push(JSON.stringify(updates.refImages)); }
    if (updates.modelId !== undefined) { sets.push("model_id = ?"); params.push(updates.modelId); }
    if (updates.cameras !== undefined) {
      sets.push("cameras_json = ?");
      params.push(JSON.stringify(updates.cameras));
      /** 兼容旧列 */
      const primary = updates.cameras[0];
      if (primary) {
        sets.push("camera_id = ?");
        params.push(primary.cameraId);
        sets.push("roi_id = ?");
        params.push(primary.roiId ?? 0);
      }
    }

    if (sets.length === 0) return false;
    params.push(id);

    const result = this.db.run(
      `UPDATE detect_rules SET ${sets.join(", ")} WHERE id = ?`,
      params
    );
    return result.changes > 0;
  }

  /** 删除规则 */
  removeRule(id: number): boolean {
    const result = this.db.run("DELETE FROM detect_rules WHERE id = ?", [id]);
    return result.changes > 0;
  }

  /** 记录检测结果（预编译语句） */
  insertRecord(ruleId: number, ruleName: string, cameraId: string, timestamp: number, result: string, matched: boolean, detail: string): number {
    const row = this.stmtInsertRecord.get(ruleId, ruleName, cameraId, timestamp, result, matched ? 1 : 0, detail);
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
  } = {}): DetectRuleRecord[] {
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
      `SELECT id, rule_id as ruleId, rule_name as ruleName, camera_id as cameraId, timestamp, result, matched, detail FROM detect_rule_records ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as DetectRuleRecord[];
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
    const row = this.db.query(`SELECT COUNT(*) as count FROM detect_rule_records ${where}`).get(...params) as { count: number };
    return row.count;
  }

  /** 清理过期记录 */
  purge(beforeTimestamp: number): number {
    const result = this.db.run("DELETE FROM detect_rule_records WHERE timestamp < ?", [beforeTimestamp]);
    return result.changes;
  }

  /** 删除所有记录 */
  purgeAll(): number {
    const count = (this.db.query("SELECT COUNT(*) as cnt FROM detect_rule_records").get() as { cnt: number }).cnt;
    this.db.run("DELETE FROM detect_rule_records");
    return count;
  }

  /** 将数据库行映射为 DetectRule（解析 JSON 字段，兼容旧数据） */
  private mapRule(row: DbRow): DetectRule {
    let stateIds: number[] = [];
    try { stateIds = JSON.parse(row.stateIdsJson); } catch { /* 空数组 */ }

    /** 解析 cameras 列表 */
    let cameras: RuleCameraSource[] = [];
    if (row.camerasJson) {
      try { cameras = JSON.parse(row.camerasJson); } catch { /* 空数组 */ }
    }
    /** 兼容旧数据：cameras_json 为空时从旧列构建 */
    if (cameras.length === 0 && row.cameraId) {
      cameras = [{ cameraId: row.cameraId, roiId: row.roiId ?? 0, offsetSec: 0 }];
    }

    let refImages: string[] = [];
    try { refImages = JSON.parse(row.refImagesJson ?? "[]"); } catch { /* 空数组 */ }

    return {
      id: row.id,
      name: row.name,
      cameras,
      prompt: row.prompt,
      intervalMs: row.intervalMs,
      cooldownMs: row.cooldownMs,
      enabled: !!row.enabled,
      imageWidth: row.imageWidth,
      stateIds,
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
