/**
 * 内存日志缓冲区
 * 拦截 console.log/warn/error，保留最近 N 条日志
 * 通过 GET /api/logs 暴露给前端，方便远程运维
 */

/** 单条日志记录 */
export interface LogEntry {
  /** 时间戳 */
  ts: number;
  /** 级别 */
  level: "log" | "warn" | "error";
  /** 来源标签（如 [Recorder]、[AiDetector]） */
  tag: string;
  /** 消息内容 */
  msg: string;
}

/** 环形缓冲区最大条数 */
const MAX_ENTRIES = 500;

/** 环形日志缓冲区 */
const ring = new Array<LogEntry | undefined>(MAX_ENTRIES);
let ringHead = 0;
let ringTail = 0;
let ringCount = 0;

/** O(1) 追加 */
function ringPush(entry: LogEntry): void {
  ring[ringTail] = entry;
  ringTail = (ringTail + 1) % MAX_ENTRIES;
  if (ringCount < MAX_ENTRIES) {
    ringCount++;
  } else {
    ring[ringHead] = undefined;
    ringHead = (ringHead + 1) % MAX_ENTRIES;
  }
}

/** 收集所有条目（保持时间顺序） */
function ringToArray(): LogEntry[] {
  const result: LogEntry[] = [];
  for (let i = 0; i < ringCount; i++) {
    const e = ring[(ringHead + i) % MAX_ENTRIES];
    if (e) result.push(e);
  }
  return result;
}

/** 从消息中提取 [Tag] 前缀 */
function extractTag(args: unknown[]): { tag: string; msg: string } {
  const first = typeof args[0] === "string" ? args[0] : "";
  const match = first.match(/^\[(\w+)\]\s*/);
  if (match) {
    return { tag: match[1]!, msg: [first.slice(match[0].length), ...args.slice(1)].join(" ") };
  }
  return { tag: "", msg: args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ") };
}

/** 保存原始 console 方法 */
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function pushEntry(level: "log" | "warn" | "error", args: unknown[]): void {
  const { tag, msg } = extractTag(args);
  ringPush({ ts: Date.now(), level, tag, msg });
}

/** 安装拦截器 */
export function installLogBuffer(): void {
  console.log = (...args: unknown[]) => {
    origLog.apply(console, args);
    pushEntry("log", args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn.apply(console, args);
    pushEntry("warn", args);
  };
  console.error = (...args: unknown[]) => {
    origError.apply(console, args);
    pushEntry("error", args);
  };
}

/** 获取日志（支持分页和过滤） */
export function getLogs(options: {
  /** 最低级别过滤：log=全部，warn=warn+error，error=仅error */
  level?: string;
  /** 标签过滤 */
  tag?: string;
  /** 返回最近 N 条 */
  limit?: number;
}): LogEntry[] {
  const minLevel = options.level === "error" ? 2 : options.level === "warn" ? 1 : 0;
  const levelMap: Record<string, number> = { log: 0, warn: 1, error: 2 };
  const limit = options.limit ?? 100;

  let filtered = ringToArray();
  if (options.tag) {
    filtered = filtered.filter((e: LogEntry) => e.tag === options.tag);
  }
  if (minLevel > 0) {
    filtered = filtered.filter((e: LogEntry) => (levelMap[e.level] ?? 0) >= minLevel);
  }

  return filtered.slice(-limit);
}
