import { Database } from "bun:sqlite";

/** 轨迹点（归一化坐标） */
export interface TrajectoryPoint {
  /** 时间戳 ms */
  ts: number;
  /** 归一化中心点 x (0-1) */
  x: number;
  /** 归一化中心点 y (0-1) */
  y: number;
  /** 检测框宽度（归一化） */
  w: number;
  /** 检测框高度（归一化） */
  h: number;
}

/** 单个目标的轨迹 */
export interface TrackTrajectory {
  trackId: number;
  label: string;
  customName?: string;
  cameraId: string;
  points: TrajectoryPoint[];
}

/**
 * 追踪轨迹存储
 * 持久化存储每个追踪目标的位置采样历史
 * 使用 SQLite 高效存储和查询
 */
export class TrackTrajectoryStorage {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_points (
        track_id INTEGER NOT NULL,
        camera_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        w REAL NOT NULL,
        h REAL NOT NULL,
        PRIMARY KEY (track_id, camera_id, ts)
      )
    `);
    /** 按摄像头+时间范围查询的索引 */
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_traj_cam_ts ON trajectory_points(camera_id, ts)"
    );
    /** 按 track_id 查询的索引 */
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_traj_track ON trajectory_points(track_id)"
    );
  }

  /** 插入一个轨迹采样点 */
  insertPoint(
    trackId: number,
    cameraId: string,
    ts: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO trajectory_points(track_id, camera_id, ts, x, y, w, h) VALUES(?, ?, ?, ?, ?, ?, ?)"
      )
      .run(trackId, cameraId, ts, x, y, w, h);
  }

  /** 批量插入同一帧的多个目标位置 */
  insertBatch(
    cameraId: string,
    ts: number,
    items: Array<{
      trackId: number;
      cx: number;
      cy: number;
      w: number;
      h: number;
    }>,
  ): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO trajectory_points(track_id, camera_id, ts, x, y, w, h) VALUES(?, ?, ?, ?, ?, ?, ?)"
    );
    const tx = this.db.transaction((rows: typeof items) => {
      for (const r of rows) {
        stmt.run(r.trackId, cameraId, ts, r.cx, r.cy, r.w, r.h);
      }
    });
    tx(items);
  }

  /**
   * 查询指定目标的轨迹
   * @param trackId 目标 ID
   * @param since 起始时间（ms），默认最近 5 分钟
   * @param limit 最大点数，默认 200
   */
  getTrajectory(
    trackId: number,
    since?: number,
    limit = 200,
  ): TrajectoryPoint[] {
    const sinceTime = since ?? Date.now() - 300_000;
    const rows = this.db
      .prepare(
        "SELECT ts, x, y, w, h FROM trajectory_points WHERE track_id = ? AND ts >= ? ORDER BY ts ASC LIMIT ?"
      )
      .all(trackId, sinceTime, limit) as Array<{
      ts: number;
      x: number;
      y: number;
      w: number;
      h: number;
    }>;
    return rows;
  }

  /**
   * 查询指定摄像头上所有活跃目标的最近轨迹
   * @param cameraId 摄像头 ID
   * @param since 起始时间（ms），默认最近 2 分钟
   */
  getCameraTrajectories(
    cameraId: string,
    since?: number,
  ): Array<{ trackId: number; points: TrajectoryPoint[] }> {
    const sinceTime = since ?? Date.now() - 120_000;
    const rows = this.db
      .prepare(
        "SELECT track_id, ts, x, y, w, h FROM trajectory_points WHERE camera_id = ? AND ts >= ? ORDER BY ts ASC"
      )
      .all(cameraId, sinceTime) as Array<{
      track_id: number;
      ts: number;
      x: number;
      y: number;
      w: number;
      h: number;
    }>;

    /** 按 trackId 分组 */
    const map = new Map<number, TrajectoryPoint[]>();
    for (const r of rows) {
      let pts = map.get(r.track_id);
      if (!pts) {
        pts = [];
        map.set(r.track_id, pts);
      }
      pts.push({ ts: r.ts, x: r.x, y: r.y, w: r.w, h: r.h });
    }

    const result: Array<{ trackId: number; points: TrajectoryPoint[] }> = [];
    map.forEach((points, trackId) => { result.push({ trackId, points }); });
    return result;
  }

  /** 删除指定目标的所有轨迹 */
  deleteByTrackId(trackId: number): void {
    this.db
      .prepare("DELETE FROM trajectory_points WHERE track_id = ?")
      .run(trackId);
  }

  /** 清理超过指定天数的轨迹数据 */
  cleanup(maxAgeDays: number): number {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const result = this.db
      .prepare("DELETE FROM trajectory_points WHERE ts < ?")
      .run(cutoff);
    return result.changes;
  }

  /** 获取轨迹点总数 */
  getPointCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM trajectory_points")
      .get() as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}
