import { invoke } from '@tauri-apps/api/core'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { onUnmounted, ref } from 'vue'

import live2d from '@/utils/live2d'
import { getCursorMonitor } from '@/utils/monitor'

import { INVOKE_KEY, WINDOW_LABEL } from '../constants'
import { useChat } from './useChat'

const appWindow = getCurrentWebviewWindow()

/** 散步进行中（闲时小动作调度器借此互斥） */
export const strolling = ref(false)

const CHECK_INTERVAL = 30_000
/** 出发门槛：系统空闲超过 10 分钟（人不在时才满屏跑） */
const DEPART_IDLE_MS = 10 * 60_000
/** 每次检查的出发概率 */
const DEPART_CHANCE = 0.12
/** 步进间隔与步长：~33fps、一步 4 物理像素 ≈ 慢悠悠散步 */
const STEP_INTERVAL = 30
const STEP_PX = 4
/** 单程时长上限（秒），到点收步 */
const MAX_WALK_SECONDS = 20
/** 人回来（键鼠恢复活动）立即停 */
const INTERRUPT_IDLE_SECONDS = 3

let initialized = false

let checkTimer: ReturnType<typeof setInterval> | undefined

let walkTimer: ReturnType<typeof setTimeout> | undefined

/** 走路摆动：Param13（整体位移）小弹跳 + 身体微摆；override 无 unset，结束必须显式归零 */
let waddleTimer: ReturnType<typeof setInterval> | undefined

let waddlePhase = 0

function startWaddle() {
  stopWaddle()

  waddleTimer = setInterval(() => {
    waddlePhase = 1 - waddlePhase

    live2d.setParameterValue('Param13', waddlePhase ? -10 : -4)
    live2d.setParameterValue('ParamAngleZ', waddlePhase ? 4 : -4)
  }, 140)
}

function stopWaddle() {
  if (waddleTimer) {
    clearInterval(waddleTimer)

    waddleTimer = void 0
  }

  live2d.setParameterValue('Param13', 0)
  live2d.setParameterValue('ParamAngleZ', 0)
}

function finishStroll() {
  stopWaddle()

  // 走完回待机
  live2d.startMotion({ group: 'Idle', no: 0, name: 'Idle_0' })

  strolling.value = false
}

/** 走一程：沿当前显示器底边缓步移动，人回来/对话开始/到边/超时即停 */
async function stroll() {
  const { status, inputVisible } = useChat()

  strolling.value = true

  try {
    const monitor = await getCursorMonitor().catch(() => null)
    const monitorX = monitor?.position.x ?? 0
    const monitorWidth = monitor?.size.width ?? 1920

    const size = await appWindow.outerSize()
    const position = await appWindow.outerPosition()
    const baselineY = position.y

    const room = Math.max(0, monitorWidth - size.width)
    let x = Math.min(Math.max(position.x - monitorX, 0), room)
    let direction = Math.random() < 0.5 ? 1 : -1

    // 起点贴边则反向出发
    if ((direction > 0 && x >= room - 20) || (direction < 0 && x <= 20)) direction = -direction

    const deadline = Date.now() + MAX_WALK_SECONDS * 1000

    await new Promise<void>((resolve) => {
      const step = async () => {
        // 人回来了（键鼠恢复活动）→ 收步
        const idleSeconds = await invoke<number | null>(INVOKE_KEY.GET_IDLE_SECONDS).catch(() => null)
        if (idleSeconds !== null && idleSeconds < INTERRUPT_IDLE_SECONDS) return resolve()

        // 对话/输入框优先于散步
        if (status.value !== 'idle' || inputVisible.value) return resolve()

        x += direction * STEP_PX

        // 到边：一半概率转身继续走，一半概率停下
        if (x <= 0 || x >= room) {
          x = Math.min(Math.max(x, 0), room)

          if (Math.random() < 0.5) {
            direction = -direction
          } else {
            return resolve()
          }
        }

        await appWindow.setPosition(new PhysicalPosition({ x: monitorX + x, y: baselineY }))

        if (Date.now() >= deadline) return resolve()

        walkTimer = setTimeout(step, STEP_INTERVAL)
      }

      void step()
    })
  } finally {
    if (walkTimer) {
      clearTimeout(walkTimer)

      walkTimer = void 0
    }

    finishStroll()
  }
}

export function useStroll() {
  if (appWindow.label !== WINDOW_LABEL.MAIN) return

  if (!initialized) {
    initialized = true

    const { status, inputVisible } = useChat()

    const check = async () => {
      if (strolling.value || status.value !== 'idle' || inputVisible.value) return

      const idleMs = (await invoke<number | null>(INVOKE_KEY.GET_IDLE_SECONDS).catch(() => null) ?? 0) * 1000
      if (idleMs < DEPART_IDLE_MS || Math.random() >= DEPART_CHANCE) return

      startWaddle()

      void stroll()
    }

    checkTimer = setInterval(check, CHECK_INTERVAL)

    onUnmounted(() => {
      if (walkTimer) clearTimeout(walkTimer)

      if (checkTimer) {
        clearInterval(checkTimer)

        checkTimer = void 0
      }

      finishStroll()

      initialized = false
    })
  }
}
