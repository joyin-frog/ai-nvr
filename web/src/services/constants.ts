/** 检测标签颜色映射 */
export const LABEL_COLORS: Record<string, string> = {
  person: '#FF6B6B',
  car: '#4ECDC4',
  truck: '#45B7D1',
  bus: '#96CEB4',
  motorcycle: '#FFEAA7',
  bicycle: '#DDA0DD',
  dog: '#F4A460',
  cat: '#FFB6C1',
}

/** 事件标记颜色：优先 person，否则取第一个 label 的颜色 */
export function eventMarkerColor(labels: string[]): string {
  if (labels.includes('person')) return LABEL_COLORS.person!
  return LABEL_COLORS[labels[0] ?? ''] ?? '#5bc0de'
}
