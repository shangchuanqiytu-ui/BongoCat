import { invoke } from '@tauri-apps/api/core'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { availableMonitors } from '@tauri-apps/api/window'
import { onUnmounted, ref } from 'vue'

import live2d from '@/utils/live2d'

import { INVOKE_KEY, WINDOW_LABEL } from '../constants'
import { useChat } from './useChat'
import { hoverHideSuppressed } from './useHoverHide'

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

/** 窗口所在显示器（散步用窗口的屏，不能用光标的——光标在副屏会把宠物带去副屏悬空走） */
async function getWindowMonitor() {
  const monitors = await availableMonitors().catch(() => [])
  if (!monitors.length) return null

  const pos = await appWindow.outerPosition().catch(() => null)
  if (pos) {
    const hit = monitors.find(m => pos.x >= m.position.x && pos.x < m.position.x + m.size.width
      && pos.y >= m.position.y && pos.y < m.position.y + m.size.height)
    if (hit) return hit
  }

  return monitors[0]
}

let initialized = false

/** 散步代数：打断/卸载时自增，旧 step 链 await 恢复后发现自己过期即自杀（防逃逸 timer） */
let strollGeneration = 0

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

  // 先归零再删 override 表项——只归零不删会永久压住 Param13/ParamAngleZ，
  // 第一次散步后蹦跳（hop）和下蹲（crouch）的位移通道就被冻结了
  live2d.setParameterValue('Param13', 0)
  live2d.setParameterValue('ParamAngleZ', 0)
  live2d.unsetParameterValue('Param13')
  live2d.unsetParameterValue('ParamAngleZ')
}

function finishStroll() {
  stopWaddle()

  hoverHideSuppressed.value = false

  // 走完回待机
  live2d.startMotion({ group: 'Idle', no: 0 })

  strolling.value = false
}

/** 走一程：沿窗口所在显示器底边缓步移动，人回来/对话开始/到边/超时/IPC 失败即停 */
async function stroll() {
  const { status, inputVisible } = useChat()

  const generation = ++strollGeneration

  strolling.value = true

  try {
    // 窗口所在显示器（光标所在会把宠物带去别的屏），失败则放弃本次散步
    const monitor = await getWindowMonitor()
    if (!monitor) return

    const { position: monPos, size: monSize } = monitor

    const size = await appWindow.outerSize().catch(() => null)
    const position = await appWindow.outerPosition().catch(() => null)
    if (!size || !position) return

    const room = Math.max(0, monSize.width - size.width)
    let x = Math.min(Math.max(position.x - monPos.x, 0), room)
    let direction = Math.random() < 0.5 ? 1 : -1

    // 贴住显示器底边行走（保持物理像素）
    const baselineY = monPos.y + monSize.height - size.height

    // 起点贴边则反向出发
    if ((direction > 0 && x >= room - 20) || (direction < 0 && x <= 20)) direction = -direction

    const deadline = Date.now() + MAX_WALK_SECONDS * 1000

    // 散步期间抑制悬停隐藏（移动窗口的矩形会让隐藏/恢复检测失真）
    hoverHideSuppressed.value = true

    await new Promise<void>((resolve) => {
      const step = async () => {
        // 本链已过期（被打断/卸载/新链开启）→ 自杀，不再 arm 下一个 timer
        if (generation !== strollGeneration || !strolling.value) return resolve()

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

        // IPC 失败（窗口销毁等）不让 promise 悬挂——散步系统会永久卡死
        await appWindow.setPosition(new PhysicalPosition({ x: monPos.x + x, y: baselineY })).catch(() => resolve())

        if (generation !== strollGeneration) return resolve()

        if (Date.now() >= deadline) return resolve()

        walkTimer = setTimeout(() => void step().catch(() => resolve()), STEP_INTERVAL)
      }

      void step().catch(() => resolve())
    })
  } finally {
    // 只清自己代数的 timer：旧链 finally 若把新链已 arm 的 timer 清掉，新链会永挂卡死
    if (generation === strollGeneration && walkTimer) {
      clearTimeout(walkTimer)

      walkTimer = void 0
    }

    // 只有自己的链还活着才收尾（新链的 finishStroll 归新链）
    if (generation === strollGeneration) finishStroll()
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
      strollGeneration++

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
