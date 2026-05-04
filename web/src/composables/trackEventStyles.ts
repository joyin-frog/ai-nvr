/**
 * 追踪行为事件样式配置（颜色 + i18n key）
 * 共享于 RecordingsPanel、TrackGallery、EventPanel 等组件
 */
export const TRACK_EVENT_STYLE: Record<string, { labelKey: string; bg: string; color: string }> = {
  'track:appeared': { labelKey: 'event.trackAppeared', bg: '#66BB6A', color: '#fff' },
  'track:disappeared': { labelKey: 'event.trackDisappeared', bg: '#EF5350', color: '#fff' },
  'track:enter-zone': { labelKey: 'event.trackEnterZone', bg: '#26A69A', color: '#fff' },
  'track:leave-zone': { labelKey: 'event.trackLeaveZone', bg: '#7E57C2', color: '#fff' },
  'track:dwell': { labelKey: 'event.trackDwell', bg: '#FF7043', color: '#fff' },
  'track:speed': { labelKey: 'event.trackSpeed', bg: '#E91E63', color: '#fff' },
  'track:line-cross': { labelKey: 'event.trackLineCross', bg: '#FF6F00', color: '#fff' },
  'track:loiter': { labelKey: 'event.trackLoiter', bg: '#795548', color: '#fff' },
  'track:approach': { labelKey: 'event.trackApproach', bg: '#E91E63', color: '#fff' },
  'track:match-suggest': { labelKey: 'event.trackMatchSuggest', bg: '#CE93D8', color: '#fff' },
  'detect': { labelKey: 'event.detect', bg: '#4ECDC4', color: '#fff' },
  'motion': { labelKey: 'event.motion', bg: '#FFC107', color: '#333' },
}
