/**
 * PTZ 云台控制模块
 * 通过 ONVIF 协议控制支持 PTZ 的摄像头
 */

import { Cam } from "onvif/promises";

/** PTZ 位置 */
export interface PtzPosition {
  /** 水平方向 (-1 ~ 1) */
  pan: number;
  /** 垂直方向 (-1 ~ 1) */
  tilt: number;
  /** 缩放 (0 ~ 1) */
  zoom: number;
}

/** PTZ 预置位 */
export interface PtzPreset {
  /** 预置位 token */
  token: string;
  /** 预置位名称 */
  name: string;
}

/** PTZ 摄像头配置 */
export interface PtzCameraConfig {
  /** 摄像头 ID */
  cameraId: string;
  /** ONVIF 设备主机地址 */
  hostname: string;
  /** ONVIF 端口（默认 80） */
  port: number;
  /** ONVIF 用户名 */
  username: string;
  /** ONVIF 密码 */
  password: string;
}

/** PTZ 控制器 — 管理所有 PTZ 摄像头的 ONVIF 连接 */
export class PtzController {
  /** 摄像头 ID → ONVIF Cam 实例 */
  private cams = new Map<string, Cam>();
  /** 摄像头 ID → 配置 */
  private configs = new Map<string, PtzCameraConfig>();

  /** 注册 PTZ 摄像头 */
  async register(config: PtzCameraConfig): Promise<void> {
    /** 已存在则先断开 */
    if (this.cams.has(config.cameraId)) {
      this.cams.delete(config.cameraId);
    }

    this.configs.set(config.cameraId, config);

    const cam = new Cam({
      hostname: config.hostname,
      port: config.port,
      username: config.username,
      password: config.password,
    });

    await cam.connect();
    this.cams.set(config.cameraId, cam);
    console.log(`[PTZ] ${config.cameraId} 已连接 (ONVIF)`);
  }

  /** 移除 PTZ 摄像头 */
  unregister(cameraId: string): void {
    this.cams.delete(cameraId);
    this.configs.delete(cameraId);
  }

  /** 检查摄像头是否支持 PTZ */
  hasPtz(cameraId: string): boolean {
    return this.cams.has(cameraId);
  }

  /** 获取所有已注册的 PTZ 摄像头 ID */
  getRegisteredIds(): string[] {
    return [...this.cams.keys()];
  }

  /** 连续移动（按住方向键时调用） */
  async continuousMove(
    cameraId: string,
    /** 移动速度 x: pan (-1~1), y: tilt (-1~1), zoom: (-1~1) */
    velocity: { x?: number; y?: number; zoom?: number },
    /** 超时（毫秒），0 = 持续移动直到 stop */
    timeout = 0,
  ): Promise<void> {
    const cam = this.getCam(cameraId);
    await cam.continuousMove({
      x: velocity.x ?? 0,
      y: velocity.y ?? 0,
      zoom: velocity.zoom ?? 0,
      timeout,
    });
  }

  /** 停止移动 */
  async stop(cameraId: string, stopZoom = true): Promise<void> {
    const cam = this.getCam(cameraId);
    await cam.stop({ panTilt: true, zoom: stopZoom });
  }

  /** 绝对移动到指定位置 */
  async absoluteMove(
    cameraId: string,
    position: { x?: number; y?: number; zoom?: number },
    speed?: { x?: number; y?: number; zoom?: number },
  ): Promise<void> {
    const cam = this.getCam(cameraId);
    await cam.absoluteMove({
      x: position.x,
      y: position.y,
      zoom: position.zoom,
      speed,
    });
  }

  /** 相对移动 */
  async relativeMove(
    cameraId: string,
    delta: { x?: number; y?: number; zoom?: number },
  ): Promise<void> {
    const cam = this.getCam(cameraId);
    await cam.relativeMove({
      x: delta.x ?? 0,
      y: delta.y ?? 0,
      zoom: delta.zoom ?? 0,
    });
  }

  /** 获取当前 PTZ 状态 */
  async getStatus(cameraId: string): Promise<PtzPosition> {
    const cam = this.getCam(cameraId);
    const status = await cam.getStatus();
    return {
      pan: Number(status.position?.x ?? 0),
      tilt: Number(status.position?.y ?? 0),
      zoom: Number(status.position?.zoom ?? 0),
    };
  }

  /** 获取预置位列表 */
  async getPresets(cameraId: string): Promise<PtzPreset[]> {
    const cam = this.getCam(cameraId);
    const presets = await cam.getPresets();
    /** presets 是以 token 为 key 的对象 */
    const result: PtzPreset[] = [];
    if (presets && typeof presets === "object") {
      for (const [token, preset] of Object.entries(presets)) {
        if (preset && typeof preset === "object") {
          result.push({
            token,
            name: (preset as { name?: string }).name ?? token,
          });
        }
      }
    }
    return result;
  }

  /** 跳转到预置位 */
  async gotoPreset(cameraId: string, presetToken: string): Promise<void> {
    const cam = this.getCam(cameraId);
    await cam.gotoPreset({ preset: presetToken });
  }

  /** 设置当前位为预置位 */
  async setPreset(cameraId: string, presetName: string): Promise<string> {
    const cam = this.getCam(cameraId);
    const result = await cam.setPreset({ presetName });
    return (result as { presetToken?: string }).presetToken ?? "";
  }

  /** 删除预置位 */
  async removePreset(cameraId: string, presetToken: string): Promise<void> {
    const cam = this.getCam(cameraId);
    await cam.removePreset({ presetToken });
  }

  /** 回到初始位置 */
  async gotoHomePosition(cameraId: string): Promise<void> {
    const cam = this.getCam(cameraId);
    await cam.gotoHomePosition();
  }

  /** 设置当前位为初始位置 */
  async setHomePosition(cameraId: string): Promise<void> {
    const cam = this.getCam(cameraId);
    await cam.setHomePosition();
  }

  /** 获取 ONVIF Cam 实例 */
  private getCam(cameraId: string): Cam {
    const cam = this.cams.get(cameraId);
    if (!cam) throw new Error(`摄像头 ${cameraId} 不支持 PTZ 或未注册`);
    return cam;
  }
}
