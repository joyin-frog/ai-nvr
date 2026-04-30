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
                                    （帧通过 WS 二进制协议推送）
                                           ↓
                                    Vue3 前端（CameraView + EventPanel + SettingsPanel）
```

## 模块说明
| 模块 | 文件 | 职责 |
|------|------|------|
| EventBus | `src/event-bus.ts` | 类型安全事件总线，模块间解耦通信 |
| Config | `src/config.ts` | 从 YAML 加载配置，`watchConfig` 支持热重载 |
| CameraManager | `src/camera/manager.ts` | 管理多个 FrameExtractor，`reloadConfig` 支持动态增删 |
| FrameExtractor | `src/camera/stream.ts` | ffmpeg 子进程 + JPEG 帧分割器，发射 online/offline 事件 |
| MotionDetector | `src/detection/motion.ts` | 灰度像素差异比对，ROI mask 过滤，扫描线光栅化多边形填充 |
| AiDetector | `src/ai/detector.ts` | HuggingFace pipeline 目标检测 |
| AiTypes | `src/ai/types.ts` | AI 检测类型定义 |
| Annotator | `src/ai/annotator.ts` | SVG 叠加检测框 + sharp 合成标注图 |
| EventStorage | `src/storage/events.ts` | bun:sqlite 事件持久化，支持查询/统计/清理 |
| RoiStorage | `src/storage/roi.ts` | bun:sqlite ROI 多边形区域存储，CRUD + getEnabledPolygons |
| AlertStorage | `src/alert/storage.ts` | bun:sqlite 告警规则和记录存储 |
| AlertEngine | `src/alert/engine.ts` | 告警规则引擎，滑动窗口计数 + 标签过滤 |
| MotionRecorder | `src/storage/recorder.ts` | 变动触发录像，ffmpeg 编码 MP4，`scheduleStop` 支持运动超时自动停止 |
| SystemMonitor | `src/monitor.ts` | 系统性能监控，FPS/内存/检测计数 |
| RuntimeConfig | `src/runtime-config.ts` | 运行时配置管理，API 可修改灵敏度/AI/录像参数 |
| API | `src/api/index.ts` | HTTP REST + WebSocket 服务，二进制帧推送协议 |
| 前端 | `web/src/` | Vue3 SPA，WebSocket 实时帧 + 事件日志 + 录像回放 + 状态面板 + 设置面板 |

## API 端点
- `GET /` / `GET /api` — 服务状态
- `GET /api/cameras` — 摄像头列表与状态
- `POST /api/cameras` — 添加摄像头
- `PATCH /api/cameras/:id` — 更新摄像头
- `DELETE /api/cameras/:id` — 删除摄像头
- `GET /api/health` — 系统健康检查 + 性能指标（FPS/内存/运行时长/检测计数）
- `GET /api/settings` — 获取运行时设置
- `PATCH /api/settings` — 更新运行时设置（motion/ai/recording）
- `GET /api/snapshot/:cameraId` — 最新帧（JPEG，回退用）
- `GET /api/detection/annotated/:cameraId` — 标注后的图片
- `GET /api/events/history?type=&cameraId=&since=&until=&limit=&offset=` — 事件历史查询
- `GET /api/roi/:cameraId` — 获取摄像头 ROI 区域列表
- `POST /api/roi` — 添加 ROI 区域（多边形顶点）
- `PATCH /api/roi/item/:id` — 更新 ROI（启用/禁用/顶点/名称）
- `DELETE /api/roi/item/:id` — 删除 ROI 区域
- `GET /api/alerts/rules` — 告警规则列表
- `POST /api/alerts/rules` — 添加告警规则
- `PATCH /api/alerts/rules/:id` — 更新告警规则
- `DELETE /api/alerts/rules/:id` — 删除告警规则
- `GET /api/alerts/history?cameraId=&since=&until=&limit=&offset=` — 告警历史查询
- `GET /api/recordings?cameraId=` — 录像列表
- `GET /api/recordings/:cameraId/:filename` — 录像文件播放
- `WS /api/events` — 实时事件推送（二进制协议：4B头长度 + JSON + 可选二进制帧）

## WebSocket 二进制协议
```
[4字节 header 长度 LE uint32][JSON header][可选 JPEG 二进制帧]
```
- frame 事件：JSON 头不含 data，帧数据作为二进制部分追加
- detect 事件：JSON 头不含 annotatedImage
- 其他事件：仅 JSON 头

## 事件流
- `frame` — 原始帧（cameraId, data: Buffer, timestamp）→ WS 二进制推送
- `motion` — 变动检测（cameraId, ratio, data: Buffer, timestamp）→ 触发录像
- `detect` — AI 检测（cameraId, timestamp, detections, annotatedImage）
- `camera:online` / `camera:offline` — 摄像头状态变化

## 数据存储
- `data/nvr.db` — SQLite 数据库（事件记录，WAL 模式）
- `data/roi.db` — SQLite 数据库（ROI 检测区域，WAL 模式）
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
- 核心视频流链路完整：RTSP → ffmpeg → 帧分割 → WS 二进制推送 → 前端实时显示
- 变动检测 + AI 检测完整：motion → DETR 目标检测 → 标注图
- 摄像头在线状态：自动检测上线/离线，WS 实时推送
- 事件持久化：所有事件存 SQLite，支持历史查询
- 变动触发录像：MP4 录像，自动分段，motion 超时停止，7天自动清理
- 录像回放 UI：列表 + 视频播放器弹窗，按摄像头筛选
- 事件面板增强：历史事件加载、类型筛选、中文标签
- 多视图布局：网格自适应 + 单路全屏切换
- 系统监控：FPS、内存、运行时长、检测计数，前端状态面板实时展示
- 移动端适配：<768px 单列布局 + 底部滑出面板
- 浏览器通知：person/car 等重要目标检测 + 摄像头离线时推送
- 配置热重载：修改 YAML 后自动增删摄像头，无需重启
- 运行时设置 API：通过 PATCH /api/settings 动态修改灵敏度/AI/录像参数
- 前端设置面板：5个侧边栏标签（事件/录像/状态/管理/设置），支持运行时参数调整
- 二进制 WebSocket 协议：替代 base64 JSON，消除 ~33% 编码开销
- blob URL 内存管理：帧更新时释放旧 URL 避免泄漏
- 双码流策略：子码流（SD）预览/检测，主码流（HD）直接 RTSP 录像
- RuntimeConfig 连接到检测器：设置面板修改实时生效（阈值、冷却、AI 置信度）
- 路径遍历防护：录像端点验证 resolved path 在存储目录内
- SQLite 优雅关闭：SIGINT 时 flush WAL
- Webhook 通知：事件推送到外部 URL，前端可配置 Webhook 地址
- 摄像头管理 UI：Web 端添加/编辑/删除摄像头，YAML 持久化 + 热重载
- 事件跳转录像：点击事件面板中的变动/检测事件，自动跳转录像标签播放对应时间的录像
- 静态文件服务：后端直接服务前端构建产物，生产模式无需单独前端服务器
- 检测快照存储：detect 事件自动保存标注图到磁盘，API 列出/获取快照，前端事件面板显示缩略图
- 生产模式：`bun run prod` 一键构建前端 + 启动后端
- 今日事件统计：状态面板显示当日变动/检测次数，30秒自动刷新
- Bug 修复：recorder forceStop 清理 recording 标志、快照文件名毫秒级精度、detectSnapshots blob URL 独立复制
- CameraView UX 增强：检测框直接叠加画面、16:9 固定宽高比、离线状态标识、标注图3秒自动恢复实时帧
- ROI（检测区域）功能：SQLite 存储多边形区域、API CRUD 端点、MotionDetector 扫描线光栅化算法实现 ROI 内像素差异比对、前端点击画面绘制多边形区域
- 告警规则引擎：AlertStorage + AlertEngine 滑动窗口计数，支持事件类型/摄像头/标签过滤/时间窗口/触发阈值/冷却时间，alert 事件经 EventBus 推送至 WebSocket/Webhook/日志
- 前端告警面板：6个侧边栏标签（事件/录像/状态/管理/告警/设置），规则 CRUD + 告警历史时间线，告警触发浏览器通知
- 录像时间轴：交互式时间轴条，24h/1h 视图切换，日期导航，当前时间指示器，点击片段直接播放
- 录像缩略图：ffmpeg 提取 MP4 帧生成 JPEG 缩略图并缓存，录像列表悬停显示预览图，时间轴片段悬停显示浮动缩略图 tooltip
- 统一数据清理：StorageCleaner 每小时自动清理事件/告警/快照/缩略图缓存，保留天数通过 RuntimeConfig 可配置，设置面板可调整清理策略并手动触发清理
- 多路时间轴同步：MultiTimeline 多摄像头轨道并列显示，24h/1h 视图，日期导航，点击片段播放
- 动态页面标题：检测/告警/离线事件闪烁浏览器标签标题，自动恢复正常状态显示
- NVR 品牌化：摄像头主题 favicon、正确的页面标题 "JK NVR"
- 磁盘用量监控：DiskUsage 模块扫描数据目录报告各子目录大小和文件数，df 获取磁盘空间，/api/health 返回存储信息，状态面板显示磁盘进度条和各目录用量明细
- 全局键盘快捷键：useKeyboard composable，1-6 切换侧边栏标签、F 全屏、Esc 退出、? 帮助面板
- 录像片段导出：RecordingExporter 使用 ffmpeg -ss/-to 裁剪 MP4，API POST /api/recordings/export + GET /api/recordings/export/:filename 下载，前端播放器弹窗内双滑块选择起止时间一键导出下载
- 告警静默时段：告警规则支持配置静默时段（如 22:00-06:00），静默期内不触发告警，支持跨午夜时段，前端 AlertPanel 添加时间选择器
- 下一步优先：告警推送渠道（邮件/钉钉）、多段录像合并导出
