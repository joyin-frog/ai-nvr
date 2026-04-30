# JK NVR - 项目状态文档

## 项目概述
轻量级 NVR（网络视频录像机）系统，事件驱动架构，支持多路摄像头实时监控、变动检测、AI 目标检测、变动触发录像。

## 技术栈
- **后端**: Bun + TypeScript，`Bun.serve()` 提供 HTTP + WebSocket
- **前端**: Vue 3 + Vite + TypeScript
- **视频处理**: ffmpeg 子进程提取 MJPEG 帧 + 录像编码
- **图像处理**: sharp（帧压缩/灰度转换/WebP转换）
- **AI 检测**: @huggingface/transformers（DETR 目标检测模型）
- **配置**: YAML（nvr_config.yml）
- **存储**: bun:sqlite（事件持久化）、文件系统（录像存储）
- **通信**: EventBus（类型安全事件总线）+ WebSocket（实时推送）

## 核心架构

```
RTSP → ffmpeg → JpegFrameSplitter → EventBus("frame")
                                           ↓
                                    ┌──────────────┐
                                    │              │
                              MotionDetector   MotionRecorder
                                    ↓              ↓
                              EventBus("motion")  MP4 录像文件
                                    ↓
                              AiDetector → EventBus("detect")
                                    ↓
                              Annotator（标注图片）
                                           ↓
                                    HTTP API + WebSocket Server
                                    （帧通过 WS base64 推送）
                                           ↓
                                    Vue3 前端（CameraView + EventPanel）
```

## 模块说明
| 模块 | 文件 | 职责 |
|------|------|------|
| EventBus | `src/event-bus.ts` | 类型安全事件总线，模块间解耦通信 |
| Config | `src/config.ts` | 从 YAML 加载配置，提取摄像头/流/AI/服务配置 |
| CameraManager | `src/camera/manager.ts` | 管理多个 FrameExtractor，压缩缓存最新帧 |
| FrameExtractor | `src/camera/stream.ts` | ffmpeg 子进程 + JPEG 帧分割器，从 RTSP 提取帧，发射 online/offline 事件 |
| MotionDetector | `src/detection/motion.ts` | 灰度像素差异比对，检测画面变动 |
| AiDetector | `src/ai/detector.ts` | HuggingFace pipeline 目标检测 |
| AiTypes | `src/ai/types.ts` | AI 检测类型定义 |
| Annotator | `src/ai/annotator.ts` | SVG 叠加检测框 + sharp 合成标注图 |
| EventStorage | `src/storage/events.ts` | bun:sqlite 事件持久化，支持查询/统计/清理 |
| MotionRecorder | `src/storage/recorder.ts` | 变动触发录像，ffmpeg 编码 MP4，自动分段/清理 |
| SystemMonitor | `src/monitor.ts` | 系统性能监控，FPS/内存/检测计数 |
| API | `src/api/index.ts` | HTTP REST + WebSocket 服务，帧通过 WS base64 推送 |
| 前端 | `web/src/` | Vue3 SPA，WebSocket 实时帧 + 事件日志 + 录像回放 + 状态面板 |

## API 端点
- `GET /` / `GET /api` — 服务状态
- `GET /api/cameras` — 摄像头列表与状态
- `GET /api/health` — 系统健康检查 + 性能指标（FPS/内存/运行时长/检测计数）
- `GET /api/snapshot/:cameraId` — 最新帧（JPEG，回退用）
- `GET /api/detection/annotated/:cameraId` — 标注后的图片
- `GET /api/events/history?type=&cameraId=&since=&until=&limit=&offset=` — 事件历史查询
- `GET /api/recordings?cameraId=` — 录像列表
- `GET /api/recordings/:cameraId/:filename` — 录像文件播放
- `WS /api/events` — 实时事件推送（frame含base64图片/motion/detect/camera:online/camera:offline）

## 事件流
- `frame` — 原始帧（cameraId, data: Buffer, timestamp）→ WS 推送含 base64 image
- `motion` — 变动检测（cameraId, ratio, data: Buffer, timestamp）→ 触发录像
- `detect` — AI 检测（cameraId, timestamp, detections, annotatedImage）
- `camera:online` / `camera:offline` — 摄像头状态变化

## 数据存储
- `data/nvr.db` — SQLite 数据库（事件记录，WAL 模式）
- `data/recordings/<cameraId>/` — MP4 录像文件（按摄像头分目录）
- `data/snapshots/` — 启动时保存的验证帧（WebP）

## 开发命令
- `bun run dev` — 后端热重载开发
- `cd web && pnpm dev` — 前端开发（端口 3200，代理到 3100）
- `cd web && pnpm build` — 前端构建

## 端口
- 后端 HTTP/WS: 3100
- 前端 Vite dev: 3200

## 当前阶段
- 核心视频流链路完整：RTSP → ffmpeg → 帧分割 → WS 推送 → 前端实时显示
- 变动检测 + AI 检测完整：motion → DETR 目标检测 → 标注图
- 摄像头在线状态：自动检测上线/离线，WS 实时推送
- 事件持久化：所有事件存 SQLite，支持历史查询
- 变动触发录像：MP4 录像，自动分段，motion 超时停止，7天自动清理
- 录像回放 UI：列表 + 视频播放器弹窗，按摄像头筛选
- 事件面板增强：历史事件加载、类型筛选、中文标签
- 多视图布局：网格自适应 + 单路全屏切换
- 系统监控：FPS、内存、运行时长、检测计数，前端状态面板实时展示
- 下一步优先：配置热重载、移动端适配、通知推送
