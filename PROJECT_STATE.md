# JK NVR - 项目状态文档

## 项目概述
轻量级 NVR（网络视频录像机）系统，事件驱动架构，支持多路摄像头实时监控、变动检测、AI 目标检测（YOLO26s + ByteTrack + CLIP 零样本分类）、变动触发录像、多模态 LLM 场景分析。

## 技术栈
- **后端**: Bun + TypeScript，`Bun.serve()` 提供 HTTP + WebSocket
- **前端**: Vue 3 + Vite + TypeScript
- **视频流**: 双模式 — fMP4/MSE（GPU 硬件解码）+ MJPEG Canvas 回退
- **视频处理**: ffmpeg 子进程（fMP4 流提取 + JPEG 帧分割 + 录像编码）
- **图像处理**: sharp（标注图合成）
- **AI 检测**: @huggingface/transformers（YOLO26s ONNX 目标检测）+ Worker 线程推理 + CLIP 零样本语义分类
- **目标追踪**: ByteTrack（IoU 匹配 + min_hits 机制，跨帧稳定 ID）
- **语义标签**: CLIP jina-clip-v2 零样本分类，自动生成丰富语义描述（如 "a black dog"）
- **多模态 LLM**: OpenAI 兼容 API（LM Studio / Ollama），场景语义分析
- **外观匹配**: dHash + 颜色直方图 + LBP 纹理，自动关联同名目标
- **行为分析**: ROI 区域进出/停留/越线/徘徊/速度告警
- **配置**: YAML（nvr_config.yml）+ 运行时热更新（RuntimeConfig）
- **存储**: bun:sqlite（事件/告警/ROI/偏好 持久化）、文件系统（录像/快照/轨迹）
- **通知**: 钉钉机器人 + 邮件(SMTP) + Webhook

## 视频流架构

```
RTSP → ffmpeg ─┬─ fMP4 流 (H264 copy / HEVC→H264 转码) → WebSocket → MSE <video> GPU 解码
               │   H264Fmp4Extractor → Fmp4StreamParser → EventBus(fmp4:init/segment)
               │
               └─ JPEG 帧 → EventBus("detect:frame")
                                  ↓
                     ┌──────────┼──────────┐
                     │          │          │
               MotionDetector  AI Worker  MJPEG WS 推送
               (sharp灰度差)  (YOLO26s)  (Canvas 回退)
                     │          ↓          │
                     ↓    ObjectTracker   <img> + Canvas
                MotionRecorder (ByteTrack)
                (帧输入录像)
                     ↓          ↓
                MP4 录像    EventBus("detect")
                                ↓
                    ┌───────────┼───────────┐
                    │           │           │
               Annotator  BehaviorAnalyzer  MultimodalAnalyzer
               (标注图)   (区域/越线/徘徊)  (LLM 场景描述)
                    ↓           ↓           ↓
               HTTP API    EventBus     EventBus("llm:scene")
                              ↓
                     WebSocket → Vue3 前端
                     (二进制协议推送)
```

## fMP4/MSE 模式（高性能）
- ffmpeg 直接输出 fMP4 格式（`frag_keyframe+empty_moov+frag_duration=1s`）
- 每秒强制分段，降低端到端延迟至 ~1 秒
- 浏览器 MediaSource + `<video>` GPU 硬件解码，零 CPU 解码开销
- HEVC 摄像头自动检测并切换到 libx264 转码（superfast + CRF 23）
- 低延迟参数：`-fflags nobuffer -flags low_delay -max_delay 0`
- 前端 SourceBuffer 管理：pruning 状态标记避免 remove/append 竞争
- 自动追赶直播：渐进加速（max 1.2x）+ 延迟过大直接 seek
- 缓存 init segment + 最后一个 media segment（新客户端立即显示画面）

## AI 检测与追踪
- YOLO26s ONNX 模型，Worker 线程推理不阻塞主线程
- 帧驱动连续检测模式：detect:frame 事件触发，80% 间隔节流，比定时器延迟更低
- ByteTrack 追踪器：min_hits=3 机制防止短暂误检产生幽灵 ID
- CLIP 零样本分类：jina-clip-v2 为检测目标生成语义标签，全链路贯通
- 外观匹配：dHash + 颜色直方图 + LBP 纹理特征
- 自动关联：高置信度匹配自动命名同名目标
- 语义标签全链路：CLIP → Detector → BehaviorAnalyzer → EventBus → 持久化 → WS → 前端 → 通知

## 多模态 LLM 场景分析
- 监听 track:appeared/enter-zone/loiter 等事件触发分析
- 将关键帧图像发送给 OpenAI 兼容 API（LM Studio / Ollama / vLLM）
- 每摄像头独立节流（默认 10s），图片可缩放减少开销
- 配置：`nvr_config.yml` 的 `ai.llm` 节点，支持热更新
- 前端 CameraView overlay 紫色半透明条显示 LLM 描述

## 行为分析事件
- ROI 区域进入/离开/停留（dwell，5s 间隔上报）
- 越线检测（线段相交判定 + A→B/B→A 方向）
- 速度告警（归一化速度向量长度超过阈值）
- 徘徊检测（位置覆盖面积 vs 总移动距离）
- 所有语义事件通过 EventBus 广播 → 前端 WS 推送 → 通知渠道

## 前端交互
- **视频渲染**: fMP4 `<video>` GPU 解码 + Canvas overlay 检测框/ROI/越线/轨迹
- **检测框**: EMA 平滑 + 速度插值动画，双击/右键直接命名目标
- **命名传播**: 命名后自动广播给其他客户端，外观匹配自动关联
- **LLM 描述**: 视频区域紫色半透明条，自动换行，15s 消失
- **事件面板**: 实时事件流 + 历史查询 + 摄像头/类型筛选
- **设置面板**: AI 参数 + LLM 配置 + 录像设置 + 告警规则 + 摄像头管理
- **TrackGallery**: 追踪目标图库 + 命名编辑 + 轨迹回放 + 热力图

## 模块说明
| 模块 | 文件 | 职责 |
|------|------|------|
| EventBus | `src/event-bus.ts` | 类型安全事件总线，模块间解耦通信 |
| Config | `src/config.ts` | 从 YAML 加载配置，`watchConfig` 支持热重载 |
| RuntimeConfig | `src/runtime-config.ts` | 运行时配置管理，API 可修改所有参数 |
| CameraManager | `src/camera/manager.ts` | 管理多个 FrameExtractor + H264Fmp4Extractor |
| FrameExtractor | `src/camera/stream.ts` | ffmpeg 子进程 + JPEG 帧分割器 |
| H264Fmp4Extractor | `src/camera/h264-fmp4-muxer.ts` | ffmpeg fMP4 流提取，HEVC 自动转码 |
| MotionDetector | `src/detection/motion.ts` | 灰度像素差异比对，ROI mask 过滤 |
| AiDetector | `src/ai/detector.ts` | YOLO Worker 管理 + ByteTrack 追踪调度 |
| detect-worker | `src/ai/detect-worker.ts` | YOLO ONNX 推理 Worker 线程 |
| ClipService | `src/ai/clip-service.ts` | CLIP 零样本分类服务（管理 Worker 生命周期） |
| clip-worker | `src/ai/clip-worker.ts` | CLIP 嵌入/零样本分类 Worker 线程 |
| ObjectTracker | `src/ai/tracker.ts` | ByteTrack 追踪器 + min_hits + ghost 恢复 |
| BehaviorAnalyzer | `src/ai/behavior.ts` | ROI/越线/速度/徘徊行为分析 |
| MultimodalAnalyzer | `src/ai/multimodal-analyzer.ts` | 多模态 LLM 场景分析 |
| Annotator | `src/ai/annotator.ts` | SVG 检测框 + sharp 合成标注图 |
| EventStorage | `src/storage/events.ts` | bun:sqlite 事件持久化 |
| TrackStorage | `src/storage/tracks.ts` | 追踪目标快照 + dHash 外观匹配 |
| AlertEngine | `src/alert/engine.ts` | 告警规则引擎 |
| MotionRecorder | `src/storage/recorder.ts` | 变动触发录像 |

## 配置 (nvr_config.yml)
```yaml
ai:
  enabled: true
  model: onnx-community/yolo26s-ONNX
  threshold: 0.6
  mode: continuous       # motion | continuous
  interval: 2000         # continuous 模式检测间隔 ms
  important_labels: [person, car, dog, cat, ...]
  llm:
    enabled: false
    api_url: http://localhost:1234/v1/chat/completions
    model: qwen3.5-0.8b  # 可自定义
    max_tokens: 150
    interval: 10000       # 每摄像头分析节流 ms
    image_width: 640      # 推理图片缩放
    triggers: [track:appeared, track:enter-zone, track:loiter]
```
