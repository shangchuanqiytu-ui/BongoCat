import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { onUnmounted } from 'vue'

import { useModelStore } from '@/stores/model'
import live2d from '@/utils/live2d'

import { INVOKE_KEY, WINDOW_LABEL } from '../constants'
import { lastEmotion, useChat } from './useChat'
import { strolling } from './useStroll'

const appWindow = getCurrentWebviewWindow()

interface IdleAction {
  group: string
  weight: number
  /** 大动作（蹦跳/下蹲）只在博士离开电脑后播，专注工作时兔兔只做小动作 */
  requireAway?: boolean
  /** 时段限定（小时，跨零点写 [22, 7] 表示 22:00~次日 7:00） */
  hours?: Array<[number, number]>
}

/**
 * 闲时行为表：微动作（晃身/哼歌/开心眯眼）做高频主力，中动作低频点缀（参考 VPet 状态机 +
 * Live2D 官方 idle 轮换）。不塞进 Idle 组——框架的 idle 回归会等概率随机选，无法按权重/时段门控。
 */
const IDLE_ACTIONS: IdleAction[] = [
  { group: 'sway', weight: 30 },
  { group: 'happy', weight: 16 },
  { group: 'hum', weight: 14 },
  { group: 'lookaround', weight: 12 },
  { group: 'wiggle', weight: 10 },
  { group: 'stretch', weight: 6 },
  { group: 'yawn', weight: 4, hours: [[22, 7]] },
  { group: 'hungry', weight: 4, hours: [[11, 13], [17, 19]] },
  { group: 'hop', weight: 8, requireAway: true },
  { group: 'crouch', weight: 6, requireAway: true },
]

const CHECK_INTERVAL = 2_000
/** 微动作节奏：8~20 秒一个小动作（太稀疏=木桩，实测 30~90s 完全不够活泼） */
const MIN_GAP = 8_000
const MAX_GAP = 20_000
/** 大动作门槛：系统空闲超过 2 分钟 */
const AWAY_MS = 120_000
/** 情绪延续：对话后 5 分钟内闲时 20% 概率回放当时的表情 */
const EMOTION_LINGER = 5 * 60_000
const EMOTION_REPLAY_CHANCE = 0.2

function inHours(hours: Array<[number, number]>, now: number) {
  const hour = new Date(now).getHours()

  return hours.some(([start, end]) => (start <= end ? hour >= start && hour < end : hour >= start || hour < end))
}

let initialized = false

let checkTimer: ReturnType<typeof setInterval> | undefined

let nextAt = 0

function scheduleNext() {
  nextAt = Date.now() + MIN_GAP + Math.random() * (MAX_GAP - MIN_GAP)
}

function pickAction(away: boolean) {
  const now = Date.now()

  const pool = IDLE_ACTIONS.filter(action => (!action.requireAway || away) && (!action.hours || inHours(action.hours, now)))
  const total = pool.reduce((sum, action) => sum + action.weight, 0)

  let roll = Math.random() * total

  for (const action of pool) {
    roll -= action.weight

    if (roll <= 0) return action
  }

  return pool[0]
}

export function useIdleBehavior() {
  // 模块每窗一份：只有主窗有模型，也只该主窗跑（与 useChat 定时器同款门禁）
  if (appWindow.label !== WINDOW_LABEL.MAIN) return

  if (!initialized) {
    initialized = true

    const { status, inputVisible } = useChat()
    const modelStore = useModelStore()

    scheduleNext()

    const tick = async () => {
      if (Date.now() < nextAt) return

      // 对话进行中/挂起等回复/输入框打开/散步中：兔兔别抢戏
      if (status.value !== 'idle' || inputVisible.value || strolling.value) return

      // 情绪延续：刚聊完的情绪偶尔冒头，比随机动作更像"还想着刚才的事"
      const emotion = lastEmotion.value

      if (emotion && Date.now() - emotion.at < EMOTION_LINGER && Math.random() < EMOTION_REPLAY_CHANCE) {
        const index = modelStore.currentExpressions.findIndex(item => item.name === emotion.name)

        if (index >= 0) {
          live2d.setExpression(index)

          scheduleNext()

          return
        }
      }

      const idleMs = (await invoke<number | null>(INVOKE_KEY.GET_IDLE_SECONDS).catch(() => null) ?? 0) * 1000

      const action = pickAction(idleMs >= AWAY_MS)

      if (!action) return

      live2d.startMotion({ group: action.group, no: 0, name: `${action.group}_0` })

      scheduleNext()
    }

    checkTimer = setInterval(tick, CHECK_INTERVAL)

    onUnmounted(() => {
      if (checkTimer) {
        clearInterval(checkTimer)

        checkTimer = void 0
      }

      initialized = false
    })
  }
}
