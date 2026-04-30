declare module "onvif/promises" {
  interface CamOptions {
    hostname: string
    port?: number
    username?: string
    password?: string
  }

  interface MoveOptions {
    x?: number | string
    y?: number | string
    zoom?: number | string
    timeout?: number
    speed?: { x?: number; y?: number; zoom?: number }
  }

  interface PresetInfo {
    name?: string
    [key: string]: unknown
  }

  interface PtzStatus {
    position?: { x?: string | number; y?: string | number; zoom?: string | number }
    moveStatus?: unknown
    utcTime?: string
  }

  class Cam {
    username?: string
    password?: string
    constructor(options: CamOptions)
    connect(): Promise<void>
    continuousMove(options: MoveOptions): Promise<unknown>
    stop(options?: { profileToken?: string; panTilt?: boolean; zoom?: boolean }): Promise<unknown>
    absoluteMove(options: MoveOptions): Promise<unknown>
    relativeMove(options: MoveOptions): Promise<unknown>
    getStatus(options?: { profileToken?: string }): Promise<PtzStatus>
    getPresets(options?: { profileToken?: string }): Promise<Record<string, PresetInfo>>
    gotoPreset(options: { preset: string; profileToken?: string; speed?: { x?: number; y?: number; zoom?: number } }): Promise<unknown>
    setPreset(options: { presetName: string; profileToken?: string }): Promise<{ presetToken?: string }>
    removePreset(options: { presetToken: string; profileToken?: string }): Promise<unknown>
    gotoHomePosition(options?: { profileToken?: string; speed?: { x?: number; y?: number; zoom?: number } }): Promise<unknown>
    setHomePosition(options?: { profileToken?: string }): Promise<unknown>
  }

  export { Cam }
}
