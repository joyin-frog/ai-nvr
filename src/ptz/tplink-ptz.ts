/**
 * TP-Link 私有 HTTP API PTZ 驱动
 * 适用于 TP-Link 安防 IPC 球机（ONVIF 不声明 PTZ 服务的型号）
 *
 * 登录流程：RSA 加密 + session token (stok)
 * PTZ 操作：POST /stok=STOK/uci
 */

import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";

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
}

/** PTZ 位置 */
export interface TplinkPtzPosition {
  pan: number;
  tilt: number;
  zoom: number;
}

/** UCI 请求响应 */
interface UciResponse {
  error_code: number;
  data?: Record<string, unknown>;
}

/**
 * TP-Link PTZ 驱动 — 通过 TP-Link 私有 HTTP CGI API 控制 PTZ
 *
 * API 格式: POST /stok=SESSION_TOKEN/uci
 * Body: {"ptz": {"action_name": {"param": "value"}}}
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
    await this.uci({
      continuous_move: {
        velocity_pan: String(velocity.x ?? 0),
        velocity_tilt: String(velocity.y ?? 0),
        velocity_zoom: String(velocity.zoom ?? 0),
      },
    });
  }

  /** 停止移动 */
  async stop(): Promise<void> {
    await this.uci({
      stop: { pan: "1", tilt: "1", zoom: "1" },
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
    };
    if (speed) {
      params.speed_pan = String(speed.x ?? 0);
      params.speed_tilt = String(speed.y ?? 0);
      params.speed_zoom = String(speed.zoom ?? 0);
    }
    await this.uci({ absolute_move: params });
  }

  /** 相对移动 */
  async relativeMove(delta: { x?: number; y?: number; zoom?: number }): Promise<void> {
    await this.uci({
      relative_move: {
        translation_pan: String(delta.x ?? 0),
        translation_tilt: String(delta.y ?? 0),
        translation_zoom: String(delta.zoom ?? 0),
      },
    });
  }

  /** 获取当前 PTZ 状态 */
  async getStatus(): Promise<TplinkPtzPosition> {
    const res = await this.uci({ get_ptz_status: {} });
    const status = (res?.data as Record<string, string>) ?? {};
    return {
      pan: Number(status.position_pan ?? 0),
      tilt: Number(status.position_tilt ?? 0),
      zoom: Number(status.position_zoom ?? 0),
    };
  }

  /** 回到初始位置 */
  async gotoHomePosition(): Promise<void> {
    await this.uci({ goto_home_position: {} });
  }

  /** 设置当前位置为初始位置 */
  async setHomePosition(): Promise<void> {
    await this.uci({ set_home_position: {} });
  }

  // ---- 内部方法 ----

  /** RSA 登录获取 stok */
  private async login(): Promise<void> {
    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = (async () => {
      try {
        const baseUrl = `http://${this.config.hostname}:${this.config.port}`;

        /** Step 1: 获取 nonce + RSA 公钥 */
        const initRes = await fetch(`${baseUrl}/cgi-bin/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "do",
            login: { username: this.config.username, password: this.config.password },
          }),
        });
        const initData = (await initRes.json()) as {
          data: { nonce: string; key: string; code: number; time: number };
          error_code: number;
        };

        if (initData.error_code !== 0 && initData.data?.code === -40404 && initData.data.time > 0) {
          throw new Error(
            `[TP-Link] 账户被锁定，请等待 ${initData.data.time} 秒后重试`,
          );
        }

        const nonce = initData.data.nonce;
        const key = decodeURIComponent(initData.data.key);

        if (!nonce || !key) {
          throw new Error(`[TP-Link] 登录失败：未获取到 nonce/key，响应: ${JSON.stringify(initData)}`);
        }

        /** Step 2: MD5(nonce + password) */
        const md5Hash = createHash("md5")
          .update(nonce + this.config.password)
          .digest("hex");
        const passwordToEncrypt = nonce + md5Hash;

        /** Step 3: RSA 加密（PKCS#1 v1.5 填充，与 jsencrypt.js 兼容） */
        const encrypted = this.rsaEncrypt(key, passwordToEncrypt);

        /** Step 4: 发送加密密码登录 */
        const loginRes = await fetch(`${baseUrl}/cgi-bin/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "do",
            login: {
              username: this.config.username,
              encrypt_type: 3,
              password: encrypted,
            },
          }),
        });
        const loginData = (await loginRes.json()) as {
          data: { stok?: string; code?: number };
          error_code: number;
        };

        if (loginData.error_code !== 0 || !loginData.data?.stok) {
          throw new Error(
            `[TP-Link] 登录失败: error_code=${loginData.error_code}, data=${JSON.stringify(loginData.data)}`,
          );
        }

        this.stok = loginData.data.stok;
      } finally {
        this.loginPromise = null;
      }
    })();

    return this.loginPromise;
  }

  /** RSA 加密（通过 openssl 转换 DER 公钥为 PEM，再加密） */
  private rsaEncrypt(base64DerKey: string, plaintext: string): string {
    const derPath = join(tmpdir(), `tplink_pub_${Date.now()}.der`);
    const pemPath = join(tmpdir(), `tplink_pub_${Date.now()}.pem`);
    const plainPath = join(tmpdir(), `tplink_pwd_${Date.now()}.bin`);
    const encPath = join(tmpdir(), `tplink_enc_${Date.now()}.bin`);

    try {
      const derBuf = Buffer.from(base64DerKey, "base64");
      writeFileSync(derPath, derBuf);

      /** DER → PEM（TP-Link 使用非标准 DER 编码，需通过 openssl 转换） */
      execSync(`openssl rsa -pubin -inform DER -in ${derPath} -outform PEM -out ${pemPath} 2>/dev/null`);

      writeFileSync(plainPath, plaintext);
      execSync(`openssl rsautl -encrypt -pubin -inkey ${pemPath} -in ${plainPath} -out ${encPath} 2>/dev/null`);

      return readFileSync(encPath).toString("base64");
    } finally {
      for (const f of [derPath, pemPath, plainPath, encPath]) {
        if (existsSync(f)) unlinkSync(f);
      }
    }
  }

  /** 发送 UCI 请求 */
  private async uci(
    action: Record<string, Record<string, string>>,
  ): Promise<UciResponse | null> {
    if (!this.stok) {
      await this.login();
    }

    const baseUrl = `http://${this.config.hostname}:${this.config.port}`;
    const url = `${baseUrl}/stok=${encodeURIComponent(this.stok)}/uci`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ptz: action }),
    });

    const data = (await res.json()) as UciResponse;

    /** stok 过期，重新登录后重试 */
    if (data.error_code === -40210 || data.error_code === -401) {
      this.stok = "";
      await this.login();
      return this.uci(action);
    }

    if (data.error_code !== 0) {
      throw new Error(`[TP-Link] UCI 错误: ${JSON.stringify(data)}`);
    }

    return data;
  }
}
