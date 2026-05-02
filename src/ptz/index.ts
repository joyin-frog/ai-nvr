/**
 * PTZ 云台控制模块
 * 支持 ONVIF 协议和 TP-Link 私有 HTTP API 两种驱动
 */

import * as http from "node:http";
import { Cam } from "onvif/promises";
import { TplinkPtzDriver } from "./tplink-ptz";

/**
 * ONVIF 专用的 keep-alive HTTP Agent
 * 复用 TCP 连接，消除每次 PTZ 命令的 TCP 握手开销（约 30-80ms）
 */
const onvifAgent = new http.Agent({
  keepAlive: true,
  /** 空闲连接保活 30 秒 */
  keepAliveMsecs: 30000,
  /** 每个目标主机最多缓存 2 条空闲连接 */
  maxSockets: 2,
});

/** PTZ 驱动类型 */
export type PtzDriver = "onvif" | "tplink";

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
  /** 驱动类型 */
  driver: PtzDriver;
  /** 设备主机地址 */
  hostname: string;
  /** 端口（默认 80） */
  port: number;
  /** 用户名 */
  username: string;
  /** 密码 */
  password: string;
  /** NVR 通道号（默认 1） */
  channel: number;
}

/** PTZ 驱动统一接口 */
interface PtzDriverInstance {
  continuousMove(
    velocity: { x?: number; y?: number; zoom?: number },
    timeout?: number,
  ): Promise<void>;
  stop(): Promise<void>;
  absoluteMove(
    position: { x?: number; y?: number; zoom?: number },
    speed?: { x?: number; y?: number; zoom?: number },
  ): Promise<void>;
  relativeMove(delta: { x?: number; y?: number; zoom?: number }): Promise<void>;
  getStatus(): Promise<PtzPosition>;
  gotoHomePosition(): Promise<void>;
  setHomePosition(): Promise<void>;
}

/** ONVIF 驱动适配器 */
class OnvifDriverAdapter implements PtzDriverInstance {
  constructor(private cam: Cam) {}

  async continuousMove(velocity: { x?: number; y?: number; zoom?: number }, timeout = 0) {
    await this.cam.continuousMove({
      x: velocity.x ?? 0,
      y: velocity.y ?? 0,
      zoom: velocity.zoom ?? 0,
      timeout,
    });
  }

  async stop() {
    await this.cam.stop({ panTilt: true, zoom: true });
  }

  async absoluteMove(
    position: { x?: number; y?: number; zoom?: number },
    speed?: { x?: number; y?: number; zoom?: number },
  ) {
    await this.cam.absoluteMove({
      x: position.x,
      y: position.y,
      zoom: position.zoom,
      speed,
    });
  }

  async relativeMove(delta: { x?: number; y?: number; zoom?: number }) {
    await this.cam.relativeMove({
      x: delta.x ?? 0,
      y: delta.y ?? 0,
      zoom: delta.zoom ?? 0,
    });
  }

  async getStatus(): Promise<PtzPosition> {
    const status = await this.cam.getStatus();
    return {
      pan: Number(status.position?.x ?? 0),
      tilt: Number(status.position?.y ?? 0),
      zoom: Number(status.position?.zoom ?? 0),
    };
  }

  async gotoHomePosition() {
    await this.cam.gotoHomePosition();
  }

  async setHomePosition() {
    await this.cam.setHomePosition();
  }

  /** ONVIF 独有：获取预置位列表 */
  async getPresets(): Promise<PtzPreset[]> {
    const presets = await this.cam.getPresets();
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

  /** ONVIF 独有：跳转预置位 */
  async gotoPreset(presetToken: string) {
    await this.cam.gotoPreset({ preset: presetToken });
  }

  /** ONVIF 独有：设置预置位 */
  async setPreset(presetName: string): Promise<string> {
    const result = await this.cam.setPreset({ presetName });
    return (result as { presetToken?: string }).presetToken ?? "";
  }

  /** ONVIF 独有：删除预置位 */
  async removePreset(presetToken: string) {
    await this.cam.removePreset({ presetToken });
  }
}

/** PTZ 控制器 — 管理所有 PTZ 摄像头的连接 */
export class PtzController {
  /** 摄像头 ID → 驱动实例 */
  private drivers = new Map<string, PtzDriverInstance>();
  /** 摄像头 ID → 驱动类型 */
  private driverTypes = new Map<string, PtzDriver>();
  /** 摄像头 ID → ONVIF 适配器（仅 onvif 驱动有） */
  private onvifAdapters = new Map<string, OnvifDriverAdapter>();

  /** 注册 PTZ 摄像头 */
  async register(config: PtzCameraConfig): Promise<void> {
    /** 已存在则先断开 */
    this.drivers.delete(config.cameraId);
    this.driverTypes.delete(config.cameraId);
    this.onvifAdapters.delete(config.cameraId);

    this.driverTypes.set(config.cameraId, config.driver);

    if (config.driver === "tplink") {
      const driver = new TplinkPtzDriver({
        hostname: config.hostname,
        port: config.port,
        username: config.username,
        password: config.password,
        channel: config.channel,
      });
      await driver.connect();
      this.drivers.set(config.cameraId, driver);
      console.log(`[PTZ] ${config.cameraId} 已连接 (TP-Link)`);
    } else {
      /** 默认 ONVIF 驱动，使用 keep-alive Agent 复用 TCP 连接 */
      const cam = new Cam({
        hostname: config.hostname,
        port: config.port,
        username: config.username,
        password: config.password,
        agent: onvifAgent,
        /** PTZ 命令超时 5 秒（默认 120s 过长，PTZ 操作应快速响应） */
        timeout: 5000,
      });

      await cam.connect();

      /**
       * 部分廉价 NVR/IPC 通过 GetServices 不返回 PTZ 服务条目，
       * 但实际支持 PTZ 操作（所有服务共用同一个 endpoint）。
       * 若 uri 中缺少 ptz，从已有的其他服务地址中推断并补上。
       */
      if (cam.uri && !cam.uri.ptz) {
        const fallback = cam.uri.media || cam.uri.device;
        if (fallback) {
          cam.uri.ptz = { ...fallback };
          console.log(
            `[PTZ] ${config.cameraId} PTZ 服务未在 GetServices 中返回，已使用 ${fallback.path} 作为 fallback`,
          );
        }
      }

      const adapter = new OnvifDriverAdapter(cam);
      this.drivers.set(config.cameraId, adapter);
      this.onvifAdapters.set(config.cameraId, adapter);
      console.log(`[PTZ] ${config.cameraId} 已连接 (ONVIF)`);
    }
  }

  /** 移除 PTZ 摄像头 */
  unregister(cameraId: string): void {
    this.drivers.delete(cameraId);
    this.driverTypes.delete(cameraId);
    this.onvifAdapters.delete(cameraId);
  }

  /** 检查摄像头是否支持 PTZ */
  hasPtz(cameraId: string): boolean {
    return this.drivers.has(cameraId);
  }

  /** 获取所有已注册的 PTZ 摄像头 ID */
  getRegisteredIds(): string[] {
    return Array.from(this.drivers.keys());
  }

  /** 连续移动（按住方向键时调用） */
  async continuousMove(
    cameraId: string,
    velocity: { x?: number; y?: number; zoom?: number },
    timeout = 0,
  ): Promise<void> {
    await this.getDriver(cameraId).continuousMove(velocity, timeout);
  }

  /** 停止移动 */
  async stop(cameraId: string, _stopZoom = true): Promise<void> {
    await this.getDriver(cameraId).stop();
  }

  /** 绝对移动到指定位置 */
  async absoluteMove(
    cameraId: string,
    position: { x?: number; y?: number; zoom?: number },
    speed?: { x?: number; y?: number; zoom?: number },
  ): Promise<void> {
    await this.getDriver(cameraId).absoluteMove(position, speed);
  }

  /** 相对移动 */
  async relativeMove(
    cameraId: string,
    delta: { x?: number; y?: number; zoom?: number },
  ): Promise<void> {
    await this.getDriver(cameraId).relativeMove(delta);
  }

  /** 获取当前 PTZ 状态 */
  async getStatus(cameraId: string): Promise<PtzPosition> {
    return this.getDriver(cameraId).getStatus();
  }

  /** 获取预置位列表（仅 ONVIF 驱动支持） */
  async getPresets(cameraId: string): Promise<PtzPreset[]> {
    const adapter = this.onvifAdapters.get(cameraId);
    if (!adapter) return [];
    return adapter.getPresets();
  }

  /** 跳转到预置位（仅 ONVIF 驱动支持） */
  async gotoPreset(cameraId: string, presetToken: string): Promise<void> {
    const adapter = this.onvifAdapters.get(cameraId);
    if (!adapter) throw new Error(`摄像头 ${cameraId} 不支持预置位（非 ONVIF 驱动）`);
    await adapter.gotoPreset(presetToken);
  }

  /** 设置当前位为预置位（仅 ONVIF 驱动支持） */
  async setPreset(cameraId: string, presetName: string): Promise<string> {
    const adapter = this.onvifAdapters.get(cameraId);
    if (!adapter) throw new Error(`摄像头 ${cameraId} 不支持预置位（非 ONVIF 驱动）`);
    return adapter.setPreset(presetName);
  }

  /** 删除预置位（仅 ONVIF 驱动支持） */
  async removePreset(cameraId: string, presetToken: string): Promise<void> {
    const adapter = this.onvifAdapters.get(cameraId);
    if (!adapter) throw new Error(`摄像头 ${cameraId} 不支持预置位（非 ONVIF 驱动）`);
    await adapter.removePreset(presetToken);
  }

  /** 回到初始位置 */
  async gotoHomePosition(cameraId: string): Promise<void> {
    await this.getDriver(cameraId).gotoHomePosition();
  }

  /** 设置当前位为初始位置 */
  async setHomePosition(cameraId: string): Promise<void> {
    await this.getDriver(cameraId).setHomePosition();
  }

  /** 获取驱动实例 */
  private getDriver(cameraId: string): PtzDriverInstance {
    const driver = this.drivers.get(cameraId);
    if (!driver) throw new Error(`摄像头 ${cameraId} 不支持 PTZ 或未注册`);
    return driver;
  }
}
