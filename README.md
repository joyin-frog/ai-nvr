# JK NVR

AI 驱动的智能网络视频录像机，基于 Bun + Vue 3 构建。

## 功能

- RTSP 摄像头接入，实时监控与录像
- 变动检测、ROI 区域监控、越线检测
- AI 场景分析（多模态 LLM）、CLIP 目标分类、语义搜索
- 目标追踪、轨迹、热力图
- 告警规则引擎 + 通知推送（Webhook / 钉钉 / 邮件）
- PTZ 云台控制（ONVIF / TP-Link）
- PWA 离线支持，中英双语

## 快速开始

```bash
git clone https://github.com/2234839/ai-nvr.git
cd jk
bun install
cd web && bun install && cd ..

cp nvr_config.yml.example nvr_config.yml
# 编辑 nvr_config.yml，填入摄像头 RTSP 地址等配置

bun run src/index.ts
```

访问 `http://localhost:3100`。

## 配置

参考 [nvr_config.yml.example](nvr_config.yml.example)。

## 致谢

感谢 [LINUX DO](https://linux.do) 社区的佬友们，这个项目的成长离不开社区的交流与支持。

## License

MIT
