import { computed, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'

/** 摄像头信息 */
interface CameraInfo {
  id: string
  name: string
}

/**
 * 提供摄像头 ID → 名称的高效查找
 * 统一替代各组件中重复的 cameraNameMap + cameraName 实现
 */
export function useCameraNameMap(cameras: Ref<CameraInfo[]>) {
  const { t } = useI18n()

  const cameraNameMap = computed(() => {
    const map = new Map<string, string>()
    for (const c of cameras.value) map.set(c.id, c.name)
    return map
  })

  function cameraName(id: string): string {
    if (!id) return t('alert.allCameras')
    return cameraNameMap.value.get(id) ?? id
  }

  return { cameraNameMap, cameraName }
}
