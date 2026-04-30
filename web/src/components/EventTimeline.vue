<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

/** 事件条目 */
interface EventItem {
  timestamp: number
  type: string
}

const props = defineProps<{
  events: EventItem[]
  /** 选中的日期（YYYY-MM-DD），默认今天 */
  date?: string
}>()

/** 事件类型颜色 */
const typeColors: Record<string, string> = {
  motion: '#FFEAA7',
  detect: '#4ECDC4',
  'camera:online': '#4CAF50',
  'camera:offline': '#F44336',
  alert: '#FFD93D',
}

/** 计算日期范围（当天 00:00 - 24:00） */
const dayRange = computed(() => {
  const d = props.date ?? new Date().toISOString().slice(0, 10)
  const start = new Date(`${d}T00:00:00`).getTime()
  const end = start + 86_400_000
  return { start, end }
})

/** 按小时分组的事件密度 */
const hourlyBuckets = computed(() => {
  const { start, end } = dayRange.value
  const filtered = props.events.filter(e => e.timestamp >= start && e.timestamp < end)

  /** 24 个桶 */
  const buckets: Array<{ count: number; types: Record<string, number> }> = []
  for (let i = 0; i < 24; i++) {
    buckets.push({ count: 0, types: {} })
  }

  for (const event of filtered) {
    const hour = new Date(event.timestamp).getHours()
    const bucket = buckets[hour]!
    bucket.count++
    bucket.types[event.type] = (bucket.types[event.type] ?? 0) + 1
  }

  return buckets
})

/** 最大密度（用于归一化高度） */
const maxCount = computed(() => {
  return Math.max(1, ...hourlyBuckets.value.map(b => b.count))
})

/** 每小时柱状条样式 */
function barStyle(bucket: { count: number; types: Record<string, number> }) {
  if (bucket.count === 0) return { height: '2px', background: '#2a2a4a' }
  /** 用最高频类型着色 */
  const dominantType = Object.entries(bucket.types).sort((a, b) => b[1] - a[1])[0]![0]
  const color = typeColors[dominantType] ?? '#4ECDC4'
  const heightPct = 4 + (bucket.count / maxCount.value) * 96
  return {
    height: `${heightPct}%`,
    background: color,
    opacity: String(0.4 + (bucket.count / maxCount.value) * 0.6),
  }
}

/** 当前小时标记 */
const currentHour = new Date().getHours()
</script>

<template>
  <div class="event-timeline">
    <div class="timeline-label">{{ t('event.timelineTitle') }}</div>
    <div class="timeline-bars">
      <div
        v-for="(bucket, h) in hourlyBuckets"
        :key="h"
        :class="['hour-col', { current: h === currentHour }]"
        :title="t('event.hourEvents', { hour: String(h).padStart(2, '0'), count: bucket.count })"
      >
        <div class="bar-track">
          <div class="bar-fill" :style="barStyle(bucket)" />
        </div>
        <span v-if="h % 3 === 0" class="hour-label">{{ String(h).padStart(2, '0') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.event-timeline {
  padding: 8px 12px;
  border-bottom: 1px solid #2a2a4a;
}

.timeline-label {
  font-size: 10px;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.timeline-bars {
  display: flex;
  gap: 2px;
  height: 36px;
  align-items: flex-end;
}

.hour-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.hour-col.current .bar-track {
  border: 1px solid #4ECDC4;
}

.bar-track {
  width: 100%;
  height: 28px;
  background: #0a0a1a;
  border-radius: 2px;
  display: flex;
  align-items: flex-end;
  overflow: hidden;
  border: 1px solid transparent;
}

.bar-fill {
  width: 100%;
  border-radius: 1px;
  transition: height 0.3s, background 0.3s;
}

.hour-label {
  font-size: 8px;
  color: #555;
  line-height: 1;
}
</style>
