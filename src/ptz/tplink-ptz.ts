/**
 * TP-Link 私有 HTTP API PTZ 驱动
 * 适用于 TP-Link 安防 IPC 球机（ONVIF 不声明 PTZ 服务的型号）
 *
 * 登录：securityEncode XOR 加密 + session token (stok)
 * PTZ：POST /stok=STOK/ds
 */

/** TP-Link PTZ 驱动配置 */
export interface TplinkPtzConfig {
  /** 设备主机地址 */
  hostname: string;
  /** HTTP 端口（默认 80） */
  port: number;
  /** 用户名 */
  username: string;
  /** 密码 */
  password: string;
  /** NVR 通道号（默认 1） */
  channel: number;
}

/** PTZ 位置 */
export interface TplinkPtzPosition {
  pan: number;
  tilt: number;
  zoom: number;
}

/** DS 请求响应 */
interface DsResponse {
  error_code: number;
  data?: Record<string, unknown>;
}

/** securityEncode 盐值 */
const SALT = "RDpbLfCPsJZ7fiv";
/** securityEncode 密钥表 */
const KEY = "yLwVl0zKqws7LgKPRQ84Mdt708T1qQ3Ha7xv3H7NyU84p21BriUWBU43odz3iP4rBL3cD02KZciXTysVXiV8ngg6vL48rPJyAUw0HurW20xqxv9aYb4M9wK1Ae0wlro510qXeU07kV57fQMc8L6aLgMLwygtc0F10a0Dg70TOoouyFhdysuRMO51yY5ZlOZZLEal1h0t9YQW0Ko7oBwmCAHoic4HYbUyVeU3sfQ1xtXcPcf1aT303wAQhv66qzW";

/**
 * TP-Link 密码加密（XOR cipher）
 * 从设备 JS (class.js) 逆向的 securityEncode 逻辑
 */
function securityEncode(password: string): string {
  let result = "";
  const pwLen = password.length;
  const saltLen = SALT.length;
  const keyLen = KEY.length;
  const maxLen = Math.max(pwLen, saltLen);
  for (let i = 0; i < maxLen; i++) {
    let pwCode = 187;
    let saltCode = 187;
    if (i < pwLen) pwCode = password.charCodeAt(i);
    if (i < saltLen) saltCode = SALT.charCodeAt(i);
    result += KEY.charAt((pwCode ^ saltCode) % keyLen);
  }
  return result;
}

/**
 * TP-Link PTZ 驱动 — 通过 TP-Link 私有 HTTP API 控制 PTZ
 *
 * 登录: POST / Body: {"method":"do","login":{...}}
 * PTZ: POST /stok=STOK/ds Body: {"ptz":{...},"method":"do"}
 */
export class TplinkPtzDriver {
  private config: TplinkPtzConfig;
  /** session token */
  private stok = "";
  /** 登录锁，防止并发登录 */
  private loginPromise: Promise<void> | null = null;

  constructor(config: TplinkPtzConfig) {
    this.config = config;
  }

  /** 连接（登录获取 stok） */
  async connect(): Promise<void> {
    await this.login();
    console.log(`[PTZ/TP-Link] 已连接 ${this.config.hostname}`);
  }

  /** 连续移动 */
  async continuousMove(
    velocity: { x?: number; y?: number; zoom?: number },
    /** 毫秒，TP-Link 私有 API 无 timeout 参数，忽略 */
    _timeout = 0,
  ): Promise<void> {
    await this.ds({
      continuous_move: {
        velocity_pan: String(velocity.x ?? 0),
        velocity_tilt: String(velocity.y ?? 0),
        velocity_zoom: String(velocity.zoom ?? 0),
        channel: String(this.config.channel),
      },
    });
  }

  /** 停止移动 */
  async stop(): Promise<void> {
    await this.ds({
      stop: {
        pan: "1",
        tilt: "1",
        zoom: "1",
        channel: String(this.config.channel),
      },
    });
  }

  /** 绝对移动 */
  async absoluteMove(
    position: { x?: number; y?: number; zoom?: number },
    speed?: { x?: number; y?: number; zoom?: number },
  ): Promise<void> {
    const params: Record<string, string> = {
      position_pan: String(position.x ?? 0),
      position_tilt: String(position.y ?? 0),
      position_zoom: String(position.zoom ?? 0),
      channel: String(this.config.channel),
    };
    if (speed) {
      params.speed_pan = String(speed.x ?? 0);
      params.speed_tilt = String(speed.y ?? 0);
      params.speed_zoom = String(speed.zoom ?? 0);
    }
    await this.ds({ absolute_move: params });
  }

  /** 相对移动 */
  async relativeMove(delta: { x?: number; y?: number; zoom?: number }): Promise<void> {
    await this.ds({
      relative_move: {
        translation_pan: String(delta.x ?? 0),
        translation_tilt: String(delta.y ?? 0),
        translation_zoom: String(delta.zoom ?? 0),
        channel: String(this.config.channel),
      },
    });
  }

  /** 获取当前 PTZ 状态 */
  async getStatus(): Promise<TplinkPtzPosition> {
    const res = await this.ds({ get_ptz_status: {} });
    const status = (res?.data as Record<string, string>) ?? {};
    return {
      pan: Number(status.position_pan ?? 0),
      tilt: Number(status.position_tilt ?? 0),
      zoom: Number(status.position_zoom ?? 0),
    };
  }

  /** 回到初始位置 */
  async gotoHomePosition(): Promise<void> {
    await this.ds({ goto_home_position: { channel: String(this.config.channel) } });
  }

  /** 设置当前位置为初始位置 */
  async setHomePosition(): Promise<void> {
    await this.ds({ set_home_position: { channel: String(this.config.channel) } });
  }

  // ---- 内部方法 ----

  /** 登录获取 stok */
  private async login(): Promise<void> {
    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = (async () => {
      try {
        const baseUrl = `http://${this.config.hostname}:${this.config.port}`;
        const encryptedPwd = securityEncode(this.config.password);

        const loginRes = await fetch(`${baseUrl}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "do",
            login: {
              username: this.config.username,
              password: encryptedPwd,
            },
          }),
        });
        const loginData = (await loginRes.json()) as {
          data?: { code?: number; time?: number };
          stok?: string;
          error_code: number;
        };

        if (loginData.error_code !== 0 || !loginData.stok) {
          /** 账户锁定检测 */
          if (loginData.data?.code === -40404 && (loginData.data?.time ?? 0) > 0) {
            throw new Error(
              `[TP-Link] 账户被锁定，请等待 ${loginData.data.time} 秒后重试`,
            );
          }
          throw new Error(
            `[TP-Link] 登录失败: error_code=${loginData.error_code}, response=${JSON.stringify(loginData)}`,
          );
        }

        this.stok = loginData.stok;
      } finally {
        this.loginPromise = null;
      }
    })();

    return this.loginPromise;
  }

  /** 发送 DS 请求 */
  private async ds(
    action: Record<string, Record<string, string>>,
  ): Promise<DsResponse | null> {
    if (!this.stok) {
      await this.login();
    }

    const baseUrl = `http://${this.config.hostname}:${this.config.port}`;
    const url = `${baseUrl}/stok=${encodeURIComponent(this.stok)}/ds`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ptz: action, method: "do" }),
    });

    const data = (await res.json()) as DsResponse;

    /** stok 过期，重新登录后重试 */
    if (data.error_code === -40210 || data.error_code === -401) {
      this.stok = "";
      await this.login();
      return this.ds(action);
    }

    if (data.error_code !== 0) {
      throw new Error(`[TP-Link] DS 错误: ${JSON.stringify(data)}`);
    }

    return data;
  }
}
