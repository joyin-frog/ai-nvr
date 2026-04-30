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
| AiDetector | `src/ai/detector.ts` | HuggingFace pipeline 目标检测，支持运行时切换模型 |
| AiTypes | `src/ai/types.ts` | AI 检测类型定义 |
| Annotator | `src/ai/annotator.ts` | SVG 叠加检测框 + sharp 合成标注图 |
| EventStorage | `src/storage/events.ts` | bun:sqlite 事件持久化，支持查询/统计/清理 |
| RoiStorage | `src/storage/roi.ts` | bun:sqlite ROI 多边形区域存储，CRUD + getEnabledPolygons |
| AlertStorage | `src/alert/storage.ts` | bun:sqlite 告警规则和记录存储 |
| AlertEngine | `src/alert/engine.ts` | 告警规则引擎，滑动窗口计数 + 标签过滤 |
| MotionRecorder | `src/storage/recorder.ts` | 变动触发录像，ffmpeg 编码 MP4，`scheduleStop` 支持运动超时自动停止 |
| SystemMonitor | `src/monitor.ts` | 系统性能监控，FPS/内存/检测计数 |
| RuntimeConfig | `src/runtime-config.ts` | 运行时配置管理，API 可修改灵敏度/AI/录像参数 |
| PtzController | `src/ptz/index.ts` | ONVIF PTZ 云台控制，管理摄像头连接，提供移动/预置位/初始位操作 |
| API | `src/api/index.ts` | HTTP REST + WebSocket 服务，二进制帧推送协议 |
| 前端 | `web/src/` | Vue3 SPA，WebSocket 实时帧 + 事件日志 + 录像回放 + 状态面板 + 设置面板 |
| EmailNotifier | `src/notify/email.ts` | SMTP 邮件告警推送，HTML 彩色卡片格式 |

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
- `GET /api/events/stats?since=&until=` — 事件统计（按类型/小时/摄像头聚合）
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
- `GET /api/ai/model` — 获取当前 AI 模型信息
- `POST /api/ai/reload-model` — 重新加载 AI 模型（可选 body.model 指定模型名）
- `GET /api/ptz/:cameraId/status` — PTZ 摄像头状态（位置信息）
- `POST /api/ptz/:cameraId/move` — 连续移动（velocity + timeout）
- `POST /api/ptz/:cameraId/stop` — 停止移动
- `POST /api/ptz/:cameraId/absolute` — 绝对移动
- `POST /api/ptz/:cameraId/relative` — 相对移动
- `GET /api/ptz/:cameraId/presets` — 预置位列表
- `POST /api/ptz/:cameraId/goto-preset` — 跳转预置位
- `POST /api/ptz/:cameraId/set-preset` — 设置预置位
- `POST /api/ptz/:cameraId/remove-preset` — 删除预置位
- `POST /api/ptz/:cameraId/home` — 回到初始位置
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
- 摄像头画面数字时钟：CameraView 在线画面左下角实时显示 YYYY-MM-DD HH:MM:SS，半透明背景+等宽字体，专业 NVR 视觉
- 告警规则编辑：AlertPanel 规则列表内联编辑，支持修改所有字段（名称/事件类型/摄像头/标签/窗口/阈值/冷却/静默时段）
- 摄像头画面截图下载：CameraView 头部截图按钮，一键下载当前画面（优先标注图），文件名含摄像头名称和时间戳
- 导出文件自动清理：StorageCleaner 集成 RecordingExporter，每小时清理超过 24 小时的导出临时文件
- WebSocket 指数退避重连 + 连接状态指示器：EventClient 重连改为指数退避（1s→30s），暴露 ConnectionState，App header 显示绿/黄/红连接状态
- 多段录像合并导出：RecordingExporter merge() 使用 ffmpeg concat demuxer 合并多个 MP4，API POST /api/recordings/merge，前端多选模式 + checkbox + 底部合并操作栏
- 事件面板时间线可视化：EventTimeline 按小时分布显示当日事件密度柱状图，主导事件类型着色（变动黄/检测青/离线红），当前小时高亮，集成到 EventPanel 头部
- 事件详情展开面板：EventPanel 点击事件行展开显示完整详情（变动比例/检测目标置信度/告警规则），展开面板内"查看录像"按钮跳转播放
- 摄像头分组筛选：CameraConfig 添加 group 字段（YAML cameras.<id>.group），API 返回 group，App header 分组下拉筛选器，按分组过滤摄像头网格
- 摄像头管理面板分组编辑：API PATCH /api/cameras/:id 支持 group 字段，CameraManagePanel 编辑表单增加分组输入，列表中显示分组标签
- 钉钉机器人告警通知：DingTalkNotifier 监听 motion/detect/offline/alert 事件，通过钉钉自定义机器人 Webhook 推送 markdown 消息，支持 HmacSHA256 加签，RuntimeConfig notify.dingtalk 配置（enabled/webhookUrl/secret），设置面板可配置
- 录像播放器倍速控制：播放器头部倍速选择器（0.5x/1x/1.5x/2x/4x/8x），与 video playbackRate 双向同步
- Token 认证保护：YAML 配置 auth.token 启用认证（空则不启用），checkAuth 中间件检查 Bearer header 或 ?token= 参数，/api/auth/check 和 /api/auth/login 端点，前端 LoginView 登录页 + localStorage 持久化 token，authFetch 自动带 Authorization，WebSocket URL 附加 token，401 自动跳转登录
- 全局 authFetch 迁移：8 个组件全部迁移到 authFetch（EventPanel/RecordingsPanel/CameraManagePanel/AlertPanel/SettingsPanel/CameraView/CameraStatusPanel/RoiEditor），authUrl() 给 video src / 下载链接附加 token
- 摄像头画面检测框持久叠加：移除标注图3秒替代实时帧机制，displayUrl 始终显示实时帧，检测框通过叠加层持久渲染（跟随 detections），标注图仅用于截图下载，消除画面闪烁
- 摄像头轮巡自动切换：header 轮巡按钮（多路时显示），可配置间隔（2-60秒）自动全屏切换摄像头，Esc 停止，P 键快捷切换，onUnmounted 清理
- 添加摄像头分组字段：CameraManagePanel 添加表单增加分组输入，addCameraToConfig 写入 YAML group，API 传递 group
- 录像片段 GIF 导出：RecordingExporter.toGif() 使用 ffmpeg 双 pass（palettegen + paletteuse bayer 抖动）生成高质量调色板 GIF（480px 宽，10fps），API POST /api/recordings/gif 端点，下载端点支持 .gif，前端导出面板 MP4/GIF 双按钮
- 自定义 AI 模型运行时切换：AiDetector reloadModel() 方法支持销毁旧 pipeline 加载新模型，加载失败自动回退，API GET /api/ai/model 查询状态 + POST /api/ai/reload-model 触发重载，RuntimeConfig 支持修改 ai.model，前端设置面板模型名称输入框 + 重载按钮 + 当前模型状态显示
- 邮件告警推送：EmailNotifier 通过 SMTP（nodemailer）发送 HTML 彩色卡片格式告警邮件，支持变动/检测/离线/告警事件，RuntimeConfig notify.email 配置（SMTP 服务器/端口/SSL/认证/收发件人），前端设置面板邮件配置区域
- PWA 离线缓存：vite-plugin-pwa 自动生成 Service Worker + Web App Manifest，standalone 模式添加到主屏幕，192/512px 图标，离线缓存所有静态资源，PWA 更新提示 toast
- 多语言 i18n：vue-i18n 集成，zh-CN 和 en 双语语言包覆盖全部 UI，App header 语言切换按钮（EN/中），localStorage 持久化选择，所有面板组件（含 CameraView/RoiEditor/EventTimeline/RecordingsTimeline/MultiTimeline）已迁移到 t() 调用
- 事件跳转录像定位：点击事件"查看录像"按钮，自动切换到录像标签、定位到对应摄像头和录像文件，视频播放器跳转到事件发生的时间点播放（loadedmetadata seek）
- 事件面板筛选增强：日期选择器、摄像头下拉筛选、事件类型筛选，利用后端已有的 since/until/cameraId 参数；"加载更多"分页按钮（offset 参数）
- 告警面板摄像头名称：AlertPanel 接收 cameras prop，规则列表和告警历史显示摄像头友好名称替代原始 ID
- 离线摄像头最后在线时间：CameraView 接收 lastFrameAt prop，离线时显示"X 分钟前在线"文本
- 侧边栏 tab 持久化：activeTab 保存到 localStorage，刷新页面恢复上次选择的标签
- 录像面板日期筛选：RecordingsPanel 添加日期选择器，前端 computed 过滤录像列表和时间轴
- 事件 CSV 导出：EventPanel 头部 CSV 按钮，按当前筛选条件（日期/摄像头/类型）导出最多 10000 条事件为 UTF-8 CSV 文件下载
- 浏览器通知国际化 + 点击跳转：通知文本全部使用 t()，点击通知自动聚焦窗口并全屏对应摄像头；App.vue 模板和事件处理中文全部国际化
- 录像连续播放：播放器头部 ▶▶ 连续播放开关，视频结束后自动播放同摄像头下一段录像（按时间排序），默认开启
- 双击全屏：CameraView 画面区域双击进入全屏，cursor:pointer 提示可交互
- 快捷键描述国际化：App.vue registerShortcut 的 description 全部使用 t() 调用
- 摄像头拖拽排序：HTML5 Drag & Drop API 实现网格拖拽重排，排序持久化到 localStorage，sortedCameras computed 应用排序
- 画面亮度/对比度/饱和度调节：CameraView 头部星号按钮展开调节面板，CSS filter 实时预览，亮度(50-200%)、对比度(50-200%)、饱和度(0-200%)，重置按钮
- 录像删除：后端 DELETE /api/recordings/:cameraId/:filename 端点（含路径遍历防护），前端录像列表 hover 显示删除按钮，confirm 确认后删除并从列表移除
- 批量删除录像：多选模式下操作栏增加"删除选中"按钮，confirm 确认后逐个调用 DELETE API，完成后从列表移除
- 画面滚轮缩放：CameraView 鼠标滚轮缩放(1x-5x) + 拖拽平移，CSS transform 实现，头部缩放倍率徽标（点击重置）
- 事件统计 API：EventStorage countByType/countByHour/countByCamera 聚合查询，GET /api/events/stats 返回按类型/小时/摄像头统计
- 状态面板事件趋势图：CameraStatusPanel 24h 柱状图展示 motion/detect 分布，纯 CSS 实现带图例
- 磁盘空间预警：App header 每 60 秒检查磁盘用量，>80% 黄色横幅，>95% 红色闪烁，展示剩余空间
- 录像播放器时间戳叠加：播放器左下角显示录像绝对时间 HH:MM:SS，随播放进度实时更新
- 录像导出按钮模板语法修复：download 按钮缺少双花括号修复
- 事件面板摄像头友好名称：事件列表显示用户定义名称替代原始 ID
- 事件搜索：后端 EventStorage query 支持 search 参数模糊匹配 detail，前端搜索框，搜索条件同步到分页和 CSV 导出
- 事件总数统计支持 search：count() 类型签名添加 search，API total 字段正确反映搜索筛选后的总数
- 实时事件筛选：addEvent 检查 filterType/filterCamera，不匹配的实时事件不插入列表
- 移动端告警标签：移动端底部面板增加告警标签按钮，EventPanel 传递 snapshots/cameras props
- 日期格式化 i18n 修复：6 个组件 10 处硬编码 zh-CN 改为 locale.value，切换语言后日期自动适配
- 服务器时间戳：/api/health 返回 serverTime 毫秒时间戳
- 网格列数切换：header 按钮循环切换 auto/1/2/3/4 列，持久化到 localStorage
- 事件面板总数：显示当前筛选条件下的事件总数
- 摄像头名称 OSD：画面左上角叠加摄像头名称标签
- 内存泄漏修复：CameraStatusPanel loadTodayStats interval、App.vue PWA interval 未清理；checkDiskSpace 间隔改为 300s 避免冗余
- 无摄像头引导空状态：网格区域显示图标+提示+添加按钮
- 录像面板总数和总大小：头部显示筛选后的录像数量和占用空间
- 侧边栏可拖拽调整宽度：左侧拖拽手柄 260-600px，宽度持久化到 localStorage
- WebSocket 重连后自动刷新：非首次连接时刷新摄像头列表和事件历史
- 事件面板排序切换：最新/最早在前按钮
- 通知权限延迟请求：改为首次点击页面时触发，需要用户手势
- 轮巡跳过离线摄像头：只遍历在线摄像头，全部离线自动停止
- WS 断开画面覆盖提示：网格顶部红色半透明横幅提示连接断开
- 事件面板快速时间范围：1h/24h 快捷按钮筛选最近事件
- 离线画面灰度效果：离线摄像头冻结帧自动叠加灰度+半透明
- PTZ 云台控制（ONVIF 协议）：PtzController 后端模块管理 ONVIF 连接，支持 continuousMove/absoluteMove/relativeMove/stop、预置位 CRUD、回到初始位置；YAML 配置 ptz 段启用；API 端点 /api/ptz/:cameraId/{move,stop,absolute,relative,status,presets,goto-preset,set-preset,remove-preset,home}；PtzControl 前端组件（方向键 D-pad + 缩放 + 预置位列表）；摄像头列表返回 ptz 字段
- 事件统计图表增强：状态面板 4 宫格（变动/检测/告警/离线）、SVG 环形图展示事件类型分布、趋势图今日 24h/7 天切换、7 天趋势含告警数据
- 移动端底部面板拖拽调整高度：触摸拖拽手柄替代固定 max-height，120px~85vh 自由调整，持久化 localStorage
- 时间轴点击精确跳转：点击时间轴片段时根据点击位置计算偏移秒数 seekToSec，空白区域点击同样计算精确偏移，单路和多路时间轴均支持
- 录像播放器自定义进度条：移除浏览器原生 controls，自定义控制栏（播放/暂停 + 可拖拽进度条 + 绝对时间显示起止 HH:MM:SS），悬停显示拖拽圆点
- 录像播放器音量控制：音量图标按钮（静音切换）+ 音量滑块，持久化 localStorage，加载时自动恢复
- 录像播放器全屏模式：player-header 全屏按钮，Browser Fullscreen API，全屏时撑满视口
- 持续录制模式（24/7）：RuntimeConfig recording.mode 支持 motion/continuous，MotionRecorder 自动分段循环录制，段间无缝衔接，设置面板可切换模式和配置分段时长
- 录像模式运行时热切换：API PATCH /api/settings 检测 mode 变更自动调用 recorder.reloadMode()，无需重启
- 摄像头全屏 Browser Fullscreen API：双击/按钮进入全屏时调用 requestFullscreen，Esc 同步退出单路模式
- 录像播放器全屏模式：player-header 全屏按钮，Browser Fullscreen API，全屏时撑满视口
- motion 事件实时去重：同一摄像头 5 秒内连续 motion 事件只更新不新增，避免事件列表被淹没
- 下一步优先：摄像头画面比例自适应、录像回放键盘快捷键（左右箭头快进/快退）
