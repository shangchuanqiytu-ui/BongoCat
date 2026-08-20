import { invoke } from '@tauri-apps/api/core'
import { error as logError } from '@tauri-apps/plugin-log'
import { useEventListener } from '@vueuse/core'
import { isString } from 'es-toolkit'
import { onUnmounted, ref, watch } from 'vue'

import { i18n } from '@/locales'
import { useAiStore } from '@/stores/ai'
import { useGeneralStore } from '@/stores/general'
import live2d from '@/utils/live2d'

import { INVOKE_KEY } from '../constants'
import { showWindow } from '../plugins/window'
import { buildSystemPrompt, dreamCheck, loadPersistedRounds, recordRound, refreshDigest, syncMemoryFromDisk } from './useChatMemory'

export type ChatStatus = 'idle' | 'thinking' | 'talking'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

const TYPE_INTERVAL = 50
const HIDE_DELAY = 8000
const MOUTH_INTERVAL = 100
const MOUTH_PARAM_ID = 'ParamMouthOpenY'
const MOUTH_MAX = 0.8
const HISTORY_ROUNDS = 8
const PROACTIVE_CHECK_INTERVAL = 60_000
const PROACTIVE_IDLE_SECONDS = 5 * 60

const PROACTIVE_PROMPTS = {
  zh: [
    '博士，休息一下眼睛吧～',
    '博士还要忙多久呀？兔兔陪你～',
    '博士，要不要喝口水？',
    '兔兔一直在这里守着博士哦～',
  ],
  en: [
    'Doctor, take a short break~',
    'How much longer will you work? I will stay with you~',
    'Doctor, how about some water?',
    'I have been here watching over you~',
  ],
}

// —— 模块级单例状态：对话是临时态，刻意不进 Pinia（saveOnChange 会把打字机 50ms 状态狂写盘并跨窗同步）
const status = ref<ChatStatus>('idle')

const displayText = ref('')

const isError = ref(false)

const inputVisible = ref(false)

const history = ref<ChatMessage[]>([])

let typewriterTimer: ReturnType<typeof setTimeout> | undefined

let hideTimer: ReturnType<typeof setTimeout> | undefined

let mouthTimer: ReturnType<typeof setInterval> | undefined

let proactiveCheckTimer: ReturnType<typeof setInterval> | undefined

let nextProactiveAt = 0

let initialized = false

function clearTypewriter() {
  if (typewriterTimer) {
    clearTimeout(typewriterTimer)

    typewriterTimer = void 0
  }
}

function scheduleHide() {
  hideTimer = setTimeout(() => {
    status.value = 'idle'

    displayText.value = ''

    isError.value = false
  }, HIDE_DELAY)
}

/** 说话嘴部动画：100ms 随机张合。override 永久生效且无 unset API，必须配对归零 */
function startMouth() {
  if (!live2d.getParameterValueRange(MOUTH_PARAM_ID)) return

  mouthTimer = setInterval(() => {
    live2d.setParameterValue(MOUTH_PARAM_ID, Math.random() * MOUTH_MAX)
  }, MOUTH_INTERVAL)
}

function stopMouth() {
  if (mouthTimer) {
    clearInterval(mouthTimer)

    mouthTimer = void 0
  }

  if (live2d.getParameterValueRange(MOUTH_PARAM_ID)) {
    live2d.setParameterValue(MOUTH_PARAM_ID, 0)
  }
}

function startTyping(text: string) {
  displayText.value = ''

  // 每帧字数随长度伸缩，保证长文本约 5s 内打完
  const charsPerTick = Math.max(1, Math.ceil(text.length / 100))

  let index = 0

  typewriterTimer = setInterval(() => {
    index += charsPerTick

    displayText.value = text.slice(0, index)

    if (index < text.length) return

    clearTypewriter()

    stopMouth()

    scheduleHide()
  }, TYPE_INTERVAL)
}

function resetSpeech() {
  clearTypewriter()

  if (hideTimer) {
    clearTimeout(hideTimer)

    hideTimer = void 0
  }

  stopMouth()

  status.value = 'idle'

  displayText.value = ''

  isError.value = false
}

export function useChat() {
  const aiStore = useAiStore()
  const generalStore = useGeneralStore()

  async function ask(question: string) {
    if (!aiStore.enabled) return

    // 任何一次对话（含主动搭话本身）都重新随机下一轮
    scheduleProactive()

    resetSpeech()

    status.value = 'thinking'

    const messages = [...history.value, { role: 'user' as const, content: question }]

    try {
      // 先从盘上同步记忆（做梦可能在别的窗口写盘）
      await syncMemoryFromDisk()

      const reply = await invoke<string>(INVOKE_KEY.AI_CHAT, {
        apiUrl: aiStore.apiUrl,
        system: buildSystemPrompt(aiStore.systemPersona),
        messages,
      })

      const nextHistory = [...messages, { role: 'assistant' as const, content: reply }]

      // 窗口溢出的轮次先落盘（diary），再 re-distill 进滚动摘要（内部自带质量守卫）
      const dropped = nextHistory.slice(0, Math.max(0, nextHistory.length - HISTORY_ROUNDS * 2))

      history.value = nextHistory.slice(-HISTORY_ROUNDS * 2)

      void recordRound(question, reply)

      void refreshDigest(dropped)

      status.value = 'talking'

      isError.value = false

      startTyping(reply)

      startMouth()
    } catch (err) {
      logError(isString(err) ? err : JSON.stringify(err))

      status.value = 'talking'

      isError.value = true

      displayText.value = i18n.global.t('pages.main.chat.error')

      scheduleHide()
    }
  }

  async function submit(question: string) {
    inputVisible.value = false

    await ask(question)
  }

  /** 点击宠物 / 快捷键唤起输入框；再点一次或失焦关闭 */
  async function openInput() {
    if (!aiStore.enabled) return

    if (inputVisible.value) {
      inputVisible.value = false

      return
    }

    showWindow()

    inputVisible.value = true
  }

  function pickProactivePrompt() {
    const prompts = generalStore.appearance.language?.startsWith('zh') ? PROACTIVE_PROMPTS.zh : PROACTIVE_PROMPTS.en

    return prompts[Math.floor(Math.random() * prompts.length)]
  }

  function scheduleProactive() {
    const min = aiStore.proactive.minInterval
    const max = Math.max(aiStore.proactive.maxInterval, min)
    const minutes = min + Math.random() * (max - min)

    nextProactiveAt = Date.now() + minutes * 60_000
  }

  async function checkProactive(idleSeconds: number | null) {
    if (!aiStore.enabled || !aiStore.proactive.enabled) return

    if (status.value !== 'idle' || inputVisible.value) return

    if (Date.now() < nextProactiveAt) return

    if (idleSeconds !== null && idleSeconds < PROACTIVE_IDLE_SECONDS) return

    void ask(pickProactivePrompt())
  }

  /** 每分钟心跳：查一次系统空闲，喂给主动搭话和空闲做梦两条链 */
  async function onMinuteTick() {
    // 系统空闲查询（GetLastInputInfo，无全局钩子）；null（非 Windows）视为空闲
    const idleSeconds = await invoke<number | null>(INVOKE_KEY.GET_IDLE_SECONDS).catch(() => null)

    void dreamCheck(idleSeconds)

    await checkProactive(idleSeconds)
  }

  if (!initialized) {
    initialized = true

    scheduleProactive()

    proactiveCheckTimer = setInterval(onMinuteTick, PROACTIVE_CHECK_INTERVAL)

    // 恢复上次会话的最近对话（Layer 0：重启不清零）
    void loadPersistedRounds(HISTORY_ROUNDS * 2).then((messages) => {
      if (messages.length && !history.value.length) history.value = messages
    })

    useEventListener(window, 'blur', () => {
      inputVisible.value = false
    })

    watch(() => [aiStore.proactive.minInterval, aiStore.proactive.maxInterval], scheduleProactive)

    onUnmounted(() => {
      resetSpeech()

      if (proactiveCheckTimer) {
        clearInterval(proactiveCheckTimer)

        proactiveCheckTimer = void 0
      }

      initialized = false
    })
  }

  return {
    status,
    displayText,
    isError,
    inputVisible,
    ask,
    submit,
    openInput,
  }
}
