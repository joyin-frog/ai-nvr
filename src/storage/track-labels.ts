import { Database } from "bun:sqlite";

/** 追踪目标标签记录 */
export interface TrackLabel {
  /** 记录 ID */
  id: number;
  /** 摄像头 ID */
  cameraId: string;
  /** 追踪 ID */
  trackId: number;
  /** 检测标签（person/car 等） */
  label: string;
  /** 用户自定义名称 */
  name: string;
  /** 首次标注图片路径（可选） */
  snapshotPath: string | null;
  /** 创建时间 */
  createdAt: number;
  /** 最后出现时间 */
  lastSeenAt: number;
}

/**
 * 追踪目标标签存储
 * 管理用户对特定 trackId 的命名和标注
 */
export class TrackLabelStorage {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS track_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id TEXT NOT NULL,
        track_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        snapshot_path TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_track_labels_camera_track
      ON track_labels(camera_id, track_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_track_labels_camera_label
      ON track_labels(camera_id, label)
    `);
  }

  /** 添加或更新追踪标签 */
  upsert(cameraId: string, trackId: number, label: string, name: string, snapshotPath?: string): TrackLabel {
    const existing = this.findByTrack(cameraId, trackId);
    if (existing) {
      const stmt = this.db.prepare(
        "UPDATE track_labels SET name = ?, last_seen_at = unixepoch() WHERE id = ? RETURNING *"
      );
      const row = stmt.get(name, existing.id) as Record<string, unknown>;
      return this.mapRow(row);
    }

    const stmt = this.db.prepare(
      `INSERT INTO track_labels (camera_id, track_id, label, name, snapshot_path, last_seen_at)
       VALUES (?, ?, ?, ?, ?, unixepoch())
       RETURNING *`
    );
    const row = stmt.get(cameraId, trackId, label, name, snapshotPath ?? null) as Record<string, unknown>;
    return this.mapRow(row);
  }

  /** 根据 camera + trackId 查找 */
  findByTrack(cameraId: string, trackId: number): TrackLabel | null {
    const stmt = this.db.prepare(
      "SELECT * FROM track_labels WHERE camera_id = ? AND track_id = ?"
    );
    const row = stmt.get(cameraId, trackId) as Record<string, unknown> | null;
    return row ? this.mapRow(row) : null;
  }

  /** 获取某摄像头的所有标签 */
  listByCamera(cameraId: string): TrackLabel[] {
    const stmt = this.db.prepare(
      "SELECT * FROM track_labels WHERE camera_id = ? ORDER BY last_seen_at DESC"
    );
    return (stmt.all(cameraId) as Record<string, unknown>[]).map(r => this.mapRow(r));
  }

  /** 获取某摄像头某类别的所有标签（如所有 person） */
  listByLabel(cameraId: string, label: string): TrackLabel[] {
    const stmt = this.db.prepare(
      "SELECT * FROM track_labels WHERE camera_id = ? AND label = ? ORDER BY last_seen_at DESC"
    );
    return (stmt.all(cameraId, label) as Record<string, unknown>[]).map(r => this.mapRow(r));
  }

  /** 删除标签 */
  remove(id: number): boolean {
    const stmt = this.db.prepare("DELETE FROM track_labels WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }

  private mapRow(row: Record<string, unknown>): TrackLabel {
    return {
      id: row.id as number,
      cameraId: row.camera_id as string,
      trackId: row.track_id as number,
      label: row.label as string,
      name: row.name as string,
      snapshotPath: row.snapshot_path as string | null,
      createdAt: row.created_at as number,
      lastSeenAt: row.last_seen_at as number,
    };
  }
}
