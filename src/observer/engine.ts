import { type Observer, type FrameProvider } from "@/observer/types";
import { type ObserverStorage } from "@/observer/storage";
import { type RuntimeConfig } from "@/runtime-config";
import { type RoiStorage } from "@/storage/roi";
import { type SignalStore } from "@/signal/store";
import { type EventBus } from "@/event-bus";
import { Scheduler } from "@/observer/scheduler";
import { FramePrep, type Recorder } from "@/observer/frame-prep";
import { VlmClient } from "@/observer/vlm-client";
import { PromptBuilder } from "@/observer/prompt-builder";
import { ResultProcessor } from "@/observer/result-processor";
import { aiMetrics } from "@/ai/metrics";

/**
 * Observer Engine（观测器引擎）
 * 组合 scheduler + framePrep + vlmClient + promptBuilder + resultProcessor
 */
export class ObserverEngine {
  private scheduler: Scheduler;
  private framePrep: FramePrep;
  private vlmClient: VlmClient;
  private promptBuilder: PromptBuilder;
  private resultProcessor: ResultProcessor;

  private runtimeConfig: RuntimeConfig;

  constructor(
    eventBus: EventBus,
    storage: ObserverStorage,
    frameProvider: FrameProvider,
    runtimeConfig: RuntimeConfig,
    roiStorage?: RoiStorage,
    signalStore?: SignalStore,
  ) {
    this.runtimeConfig = runtimeConfig;

    this.scheduler = new Scheduler(
      storage,
      (obs, frame, ts) => this.executeObserver(obs, frame, ts),
      (cameraId) => frameProvider.getLatestFrame(cameraId),
    );

    this.framePrep = new FramePrep(frameProvider, roiStorage);
    this.vlmClient = new VlmClient(runtimeConfig);
    this.promptBuilder = new PromptBuilder();
    this.resultProcessor = new ResultProcessor({ eventBus, storage, signalStore, roiStorage });
  }

  setRecorder(rec: Recorder): void { this.framePrep.setRecorder(rec); }
  setFfmpegPath(path: string): void { this.framePrep.setFfmpegPath(path); }
  setRefImagesDir(dir: string): void { this.framePrep.setRefImagesDir(dir); }

  setSaveSnapshot(fn: (cameraId: string, timestamp: number, jpeg: Buffer) => void): void {
    this.resultProcessor.setSaveSnapshot(fn);
  }

  start(): void {
    this.scheduler.start();
    console.log("[ObserverEngine] 观测器引擎已启动");
  }

  stop(): void {
    this.scheduler.stop();
    this.resultProcessor.clearCaches();
  }

  reloadRules(): void {
    this.scheduler.reloadRules();
    this.resultProcessor.clearCaches();
  }

  private async executeObserver(obs: Observer, frame: Buffer, timestamp: number): Promise<void> {
    this.scheduler.takeSlot();
    const t0 = performance.now();

    try {
      const modelConfig = this.vlmClient.resolveModelConfig(obs.modelId || undefined);
      if (!modelConfig) return;

      const aiCfg = this.runtimeConfig.get().ai;
      const imageWidth = obs.imageWidth > 0 ? obs.imageWidth : aiCfg.llm.imageWidth;

      const lang = this.runtimeConfig.get().language;
      const langInstruction = lang.startsWith("zh") ? "\nIMPORTANT: Write the description in Chinese (中文)." : "";

      /** 准备帧 */
      const prepared = await this.framePrep.prepare(obs, frame, timestamp, imageWidth, {
        contextIntervalMs: aiCfg.llm.contextIntervalMs,
      });

      /** 读取关联信号 */
      const allSignals = this.resultProcessor.getSignalContexts();
      const signals = allSignals.filter(s => obs.signalIds.includes(s.id));

      /** 构建 prompt */
      const promptResult = this.promptBuilder.build(obs, prepared.hasContext, signals, langInstruction);
      const maxTokens = this.promptBuilder.computeMaxTokens(obs, prepared.hasContext);

      /** 调用 VLM */
      const vlmResult = await this.vlmClient.call(modelConfig, promptResult.systemPrompt, prepared.userContent, maxTokens);

      /** 处理结果 */
      this.resultProcessor.process(vlmResult, obs, prepared, timestamp, vlmResult.rawContent ?? vlmResult.description, performance.now() - t0);

      /** 更新冷却 */
      this.scheduler.updateCooldown(obs.id, timestamp);
    } catch (err) {
      aiMetrics.record({ source: "rule", inferMs: performance.now() - t0, ok: false });
      console.warn(`[ObserverEngine] "${obs.name}" 执行失败:`, err instanceof Error ? err.message : String(err));
    } finally {
      this.scheduler.onSlotFreed();
    }
  }
}
