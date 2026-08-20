import type { PhysicalPosition } from '@tauri-apps/api/dpi'

import { LogicalSize } from '@tauri-apps/api/dpi'
import { resolveResource, sep } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { message } from 'antdv-next'
import { isNil, round } from 'es-toolkit'
import { findKey, nth } from 'es-toolkit/compat'
import { ref } from 'vue'

import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { getCursorMonitor } from '@/utils/monitor'
import { isMac } from '@/utils/platform'

import live2d from '../utils/live2d'

const appWindow = getCurrentWebviewWindow()
const digitKeys = '1234567890'.split('') as readonly string[]
const letterKeys = 'QWERTYUIOPASDFGHJKLZXCVBNM'.split('') as readonly string[]

export interface ModelSize {
  width: number
  height: number
}

export function useModel() {
  const modelStore = useModelStore()
  const catStore = useCatStore()
  const modelSize = ref<ModelSize>()

  function getBehaviorShortcut(index: number) {
    const primary = isMac ? 'Command' : 'Control'

    const modifierGroups = [
      [primary],
      [primary, 'Shift'],
      [primary, 'Alt'],
      [primary, 'Shift', 'Alt'],
    ]

    const tiers = [
      ...modifierGroups.map(modifiers => ({ modifiers, keys: digitKeys })),
      ...modifierGroups.map(modifiers => ({ modifiers, keys: letterKeys })),
    ]

    let nextIndex = index

    for (const tier of tiers) {
      if (nextIndex < tier.keys.length) {
        return [...tier.modifiers, tier.keys[nextIndex]].join('+')
      }

      nextIndex -= tier.keys.length
    }

    return ''
  }

  function getMotionShortcutId(modelId: string, groupName: string, index: number) {
    return `${modelId}:motion:${groupName}:${index}`
  }

  function getExpressionShortcutId(modelId: string, index: number) {
    return `${modelId}:expression:${index}`
  }

  async function handleLoad() {
    try {
      if (!modelStore.currentModel) return

      const { path } = modelStore.currentModel

      await resolveResource(path)

      const { width, height, motions, expressions } = await live2d.load(path)

      const nextMotions = Object.entries(motions)

      modelSize.value = { width, height }
      modelStore.currentMotions = nextMotions
      modelStore.currentExpressions = expressions

      handleResize()

      const modelId = modelStore.currentModel.id

      const behaviorIds: string[] = []

      for (const [groupName, items] of nextMotions) {
        for (const [index] of items.entries()) {
          behaviorIds.push(getMotionShortcutId(modelId, groupName, index))
        }
      }

      for (const [index] of expressions.entries()) {
        behaviorIds.push(getExpressionShortcutId(modelId, index))
      }

      // 清理当前模型下已不存在的行为快捷键（换模型后遗留的旧组，如 CAT_motion），
      // 避免旧键位和新行为撞车（曾出现 Ctrl+5 同时绑给 weapon 和表情1，快捷键随机失灵）
      const validIds = new Set(behaviorIds)
      const idPrefix = `${modelId}:`

      for (const id of Object.keys(modelStore.shortcuts)) {
        if (id.startsWith(idPrefix) && !validIds.has(id)) {
          delete modelStore.shortcuts[id]
        }
      }

      // 全量重排键位（不保留旧值）：旧值来自行为数不同的历史版本，继续沿用会互相冲突
      for (const [index, id] of behaviorIds.entries()) {
        const shortcut = getBehaviorShortcut(index)

        if (!shortcut) continue

        modelStore.shortcuts[id] = shortcut
      }
    } catch (error) {
      message.error(String(error))
    }
  }

  function handleDestroy() {
    live2d.destroy()
  }

  async function handleResize() {
    if (!modelSize.value) return

    live2d.resizeModel(modelSize.value)

    const { width, height } = modelSize.value

    if (round(innerWidth / innerHeight, 1) !== round(width / height, 1)) {
      await appWindow.setSize(
        new LogicalSize({
          width: innerWidth,
          height: Math.ceil(innerWidth * (height / width)),
        }),
      )
    }

    const size = await appWindow.size()

    catStore.window.scale = round((size.width / width) * 100)
  }

  /**
   * 加载超大模型（如全尺寸 2332×2192 的 Live2D 角色）时，
   * 自动缩小到屏幕高度的 45% 再居中，避免占满整个屏幕。
   */
  async function handleAutoFit() {
    if (!modelSize.value) return

    const { height } = modelSize.value

    // 用 Tauri 的屏幕 API 拿真实工作区高度（比 window.screen 更可靠）
    let screenHeight: number

    try {
      const monitor = await getCursorMonitor()

      screenHeight = monitor?.size.height ?? window.screen.availHeight
    } catch {
      screenHeight = window.screen.availHeight
    }

    if (height <= screenHeight * 0.9) return

    const scale = Math.max(10, Math.round((screenHeight * 0.36 / height) * 100))

    catStore.window.scale = scale
  }

  const handlePress = (key: string) => {
    const path = modelStore.supportKeys[key]

    if (!path) return

    const dirName = nth(path.split(sep()), -2)!
    const prevKey = findKey(modelStore.pressedKeys, (value) => {
      return value.includes(dirName)
    })

    if (prevKey) {
      handleRelease(prevKey)
    }

    modelStore.pressedKeys[key] = path
  }

  const handleRelease = (key: string) => {
    delete modelStore.pressedKeys[key]
  }

  function handleKeyChange(isLeft = true, pressed = true) {
    const id = isLeft ? 'CatParamLeftHandDown' : 'CatParamRightHandDown'

    live2d.setParameterValue(id, pressed)
  }

  function handleMouseChange(key: string, pressed = true) {
    const id = key === 'Left' ? 'ParamMouseLeftDown' : 'ParamMouseRightDown'

    live2d.setParameterValue(id, pressed)
  }

  async function handleMouseMove(cursorPoint: PhysicalPosition) {
    const monitor = await getCursorMonitor(cursorPoint)

    if (!monitor) return

    const { size, position } = monitor

    const xRatio = (cursorPoint.x - position.x) / size.width
    const yRatio = (cursorPoint.y - position.y) / size.height

    for (const id of [
      'ParamMouseX',
      'ParamMouseY',
      'ParamAngleX',
      'ParamAngleY',
      'ParamAngleZ',
      'ParamEyeBallX',
      'ParamEyeBallY',
    ]) {
      const range = live2d.getParameterValueRange(id)

      if (!range) continue

      const { min, max } = range

      if (isNil(min) || isNil(max)) continue

      const isXAxis = id.endsWith('X')
      const isYAxis = id.endsWith('Y')
      const isZAxis = id.endsWith('Z')

      let value: number

      if (isZAxis) {
        const dragX = 1 - 2 * xRatio
        const dragY = 1 - 2 * yRatio

        value = dragX * dragY * min
      } else {
        const ratio = isXAxis ? xRatio : yRatio

        value = max - ratio * (max - min)
      }

      if (!isYAxis && catStore.model.mouseMirror) {
        value *= -1
      }

      live2d.setParameterValue(id, value)
    }
  }

  async function handleAxisChange(id: string, value: number) {
    const range = live2d.getParameterValueRange(id)

    if (!range) return

    const { min, max } = range

    live2d.setParameterValue(id, Math.max(min, value * max))
  }

  return {
    modelSize,
    handlePress,
    handleRelease,
    handleLoad,
    handleDestroy,
    handleResize,
    handleAutoFit,
    handleKeyChange,
    handleMouseChange,
    handleMouseMove,
    handleAxisChange,
  }
}
