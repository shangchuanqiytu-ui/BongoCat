import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { error as logError } from '@tauri-apps/plugin-log'
import { useEventListener } from '@vueuse/core'
import { isString } from 'es-toolkit'
import { onUnmounted, ref, watch } from 'vue'

import { i18n } from '@/locales'
import { useAiStore } from '@/stores/ai'
import { useGeneralStore } from '@/stores/general'
import { useModelStore } from '@/stores/model'
import live2d from '@/utils/live2d'

import { INVOKE_KEY, LISTEN_KEY, WINDOW_LABEL } from '../constants'
import { showWindow } from '../plugins/window'
import { buildSystemPrompt, dreamCheck, loadPersistedRounds, recordRound, refreshDigest, syncMemoryFromDisk, withChatRoundLock } from './useChatMemory'
import { useTauriListen } from './useTauriListen'

const appWindow = getCurrentWebviewWindow()

export type ChatStatus = 'idle' | 'thinking' | 'talking' | 'awaiting'

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
/** 10s 心跳：起意等博士回来时需要尽快感知"回来了"，普通定时也一并复用（查询成本可忽略） */
const PROACTIVE_CHECK_INTERVAL = 10_000
const PROACTIVE_IDLE_SECONDS = 5 * 60
/** 空闲回落到该值以下视为"博士回来了" */
const RETURN_ACTIVE_SECONDS = 30

/**
 * 主动搭话不用固定台词，让模型结合记忆自由发挥；指令随对话史保留以避免重复。
 *  两条路径：博士在电脑前（present）立刻说；博士不在先起意，回来那一刻说（returned）。
 */
const PROACTIVE_INSTRUCTIONS = {
  zh: {
    present: '（主动搭话时机：博士就在电脑前。兔兔想主动说句话。结合你对博士的长期记忆和最近聊过的事——比如关心之前提到的话题——或开个新的小话题都可以。不要提"记忆"这类词，不要重复以前主动说过的话，像平常一样自然地说一两句。）',
    returned: '（主动搭话时机：博士刚刚回到电脑前。兔兔想跟博士打个招呼。可以结合你对博士的长期记忆和最近聊过的事，也可以欢迎博士回来。不要提"记忆"这类词，不要重复以前主动说过的话，像平常一样自然地说一两句。）',
  },
  en: {
    present: '(Proactive moment: the Doctor is at the computer. Say something — you may follow up on something from your long-term memory or recent chats, or start a light new topic. Do not mention "memory", do not repeat your previous openers, keep it natural and short.)',
    returned: '(Proactive moment: the Doctor has just returned to the computer. Greet them — you may recall something from your long-term memory or recent chats. Do not mention "memory", do not repeat your previous openers, keep it natural and short.)',
  },
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

/** 到点时博士不在：起意等回来，绝不把气泡说给空气听 */
let pendingProactiveGreeting = false

/** 本轮（主动搭话）的气泡打完要挂起等互动：跨窗事件在打字中到达时按此判定收起 */
let holdBubble = false

/** 最近一次对话情绪（闲时行为借它做"情绪延续"：刚聊完开心，之后几分钟偶尔冒微笑） */
export const lastEmotion = ref<{ name: string, at: number }>()

/** 纯特效/道具型表情（舞台灯光/背景/音符/饭碗等）——不是情绪脸，进工具候选只会干扰模型选择 */
const NON_EMOTION_EXPRESSIONS = new Set([
  '复位',
  '蓝色灯光',
  '黄色灯光',
  '红色灯光',
  '背景出场',
  '粉色音符',
  '蓝色音符',
  '翻手',
  '脱外套',
  '端锅',
  '喇叭',
  '敲门',
  '吃饭',
])

/** 可被对话工具调用的动作组（model3.json 的 Motions key），描述即给模型的语义指引 */
const MOTION_CHOICES = [
  { id: 'hop', desc: '原地蹦跳。博士说跳、蹦、跑、运动、活动时都用这个' },
  { id: 'wave', desc: '挥手告别、打招呼' },
  { id: 'nod', desc: '点头（同意、应允）' },
  { id: 'shake', desc: '摇头（拒绝、否定）' },
  { id: 'tilt', desc: '歪头（好奇、疑惑）' },
  { id: 'celebrate', desc: '庆祝欢呼（好消息、成功）' },
  { id: 'yawn', desc: '打哈欠（困倦、深夜）' },
  { id: 'stretch', desc: '伸懒腰（放松、刚睡醒）' },
  { id: 'music', desc: '弹琴演奏，音符环绕。仅当聊到唱歌、音乐、乐器、跳舞时才用' },
] as const

/** 工具调用协议（Anthropic tool use）：模型按 schema 语义自主决定调表情/动作，替代早期的回复开头标签约定 */
interface ToolUse {
  name: string
  input: { motion?: string, expression?: string } & Record<string, unknown>
}

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

/** 说话嘴部动画 + 身体轻摆相位：100ms 随机张合、±2.5° 正弦摆。override 永久生效且无 unset API，必须配对归零 */
let swayPhase = 0

function startMouth() {
  if (!live2d.getParameterValueRange(MOUTH_PARAM_ID)) return

  swayPhase = 0

  mouthTimer = setInterval(() => {
    swayPhase += 0.25

    live2d.setParameterValue(MOUTH_PARAM_ID, Math.random() * MOUTH_MAX)

    live2d.setParameterValue('ParamAngleZ', Math.sin(swayPhase) * 2.5)
  }, MOUTH_INTERVAL)
}

function stopMouth() {
  if (mouthTimer) {
    clearInterval(mouthTimer)

    mouthTimer = void 0
  }

  // 先写 0 让嘴立刻闭上/身体立刻回正，再删 override 表项——
  // 只写 0 不删表项会永久压制这两个参数的动作曲线（说话后歪身/晃身全被冻住）
  if (live2d.getParameterValueRange(MOUTH_PARAM_ID)) {
    live2d.setParameterValue(MOUTH_PARAM_ID, 0)
  }

  live2d.setParameterValue('ParamAngleZ', 0)
  live2d.unsetParameterValue(MOUTH_PARAM_ID)
  live2d.unsetParameterValue('ParamAngleZ')
}

function startTyping(text: string, holdWhenDone = false) {
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

    // 主动搭话说完保持挂起（等博士回复/跳过）；自己问的 8s 自动收起
    if (holdWhenDone) {
      status.value = 'awaiting'
    } else {
      scheduleHide()
    }
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

  holdBubble = false
}

export function useChat() {
  const aiStore = useAiStore()
  const generalStore = useGeneralStore()
  const modelStore = useModelStore()

  /**
   * 发起一轮对话。hold=true（主动搭话）说完保持挂起等博士回复/跳过；
   * 返回回复文本（聊天记录窗可直接消费），失败返回 undefined。
   * 全程持跨窗口对话锁：并发 ask（宠物窗+聊天窗）串行执行，快照不再互缺。
   */
  async function ask(question: string, options?: { hold?: boolean }) {
    if (!aiStore.enabled) return

    // 任何一次对话（含主动搭话本身）都重新随机下一轮
    scheduleProactive()

    resetSpeech()

    holdBubble = options?.hold === true

    status.value = 'thinking'

    return await withChatRoundLock(async () => {
      try {
        // 先从盘上同步：聊天窗/宠物窗共用磁盘态，历史与记忆都以盘为准（锁内轮转）
        const [persisted] = await Promise.all([loadPersistedRounds(HISTORY_ROUNDS * 2, { rotate: true }), syncMemoryFromDisk()])

        // 工具调用的多轮漂移（与标签协议同构）：历史纯文本让模型模仿"光说话不调工具"，几轮后调用率衰减到零。
        // 给历史注入伪 tool_use（assistant 数组 content）+ 配对 tool_result（user 数组 content 头部），
        // 协议完整、只存在于本次请求；落盘历史保持纯文本
        const exprNames = modelStore.currentExpressions.map(item => item.name).filter(name => !NON_EMOTION_EXPRESSIONS.has(name))
        const motionIds = MOTION_CHOICES.map(choice => choice.id)
        const pickRandom = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]

        const anchored = aiStore.emotionEnabled && exprNames.length
          ? persisted.map((item, index) => {
              if (item.role !== 'assistant') return item

              const calls: Array<Record<string, unknown>> = [
                { type: 'tool_use', id: `hist-${index}-e`, name: 'set_expression', input: { expression: pickRandom(exprNames) } },
              ]

              if (Math.random() < 0.5 && motionIds.length) {
                calls.push({ type: 'tool_use', id: `hist-${index}-m`, name: 'play_motion', input: { motion: pickRandom(motionIds) } })
              }

              return { role: 'assistant' as const, content: [...calls, { type: 'text', text: item.content }] }
            })
          : persisted

        const messages = [...anchored.map((item, index) => {
          const next = anchored[index + 1]

          // assistant 带伪 tool_use 时，其后的 user 消息头部补配对 tool_result（协议要求）
          if (item.role === 'user' && Array.isArray(next?.content)) {
            const ids = (next.content as Array<{ type: string, id?: string }>).filter(block => block.type === 'tool_use' && block.id).map(block => block.id)

            const results = ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: 'done' }))

            return { role: 'user' as const, content: [...results, { type: 'text', text: item.content }] }
          }

          return item
        }), { role: 'user' as const, content: question }]

        // key 每轮直读凭据管理器：偏好窗改 key 后本窗（模块实例各窗一份）立即拿到新值
        const apiKey = await invoke<string | null>(INVOKE_KEY.GET_API_KEY).catch(() => null) ?? ''

        const tools = aiStore.emotionEnabled ? buildTools() : undefined

        const outcome = await invoke<{ text: string, toolUses: ToolUse[] }>(INVOKE_KEY.AI_CHAT, {
          apiUrl: aiStore.apiUrl,
          apiKey,
          model: aiStore.model,
          system: buildSystemPrompt(aiStore.systemPersona) + (aiStore.emotionEnabled ? buildToolInstruction() : ''),
          messages,
          tools,
          maxTokens: 500,
        })

        let reply = outcome.text

        // 模型只调工具不说话（stop_reason=tool_use 且无正文）的兜底：给一句默认台词
        if (!reply) reply = '（兔兔动了动～）'

        // 解析工具调用：表情名查当前注册表，动作 id 查选择表，非法值忽略
        let emotion: string | undefined
        let motion: string | undefined

        if (aiStore.emotionEnabled) {
          for (const call of outcome.toolUses ?? []) {
            if (call.name === 'set_expression' && call.input.expression) {
              if (modelStore.currentExpressions.some(item => item.name === call.input.expression)) emotion = call.input.expression
            } else if (call.name === 'play_motion' && call.input.motion) {
              if (MOTION_CHOICES.some(choice => choice.id === call.input.motion)) motion = call.input.motion
            }
          }
        }

        const nextHistory = [...persisted, { role: 'user' as const, content: question }, { role: 'assistant' as const, content: reply }]

        // 窗口溢出的轮次先落盘（diary），再 re-distill 进滚动摘要（内部自带质量守卫）
        const dropped = nextHistory.slice(0, Math.max(0, nextHistory.length - HISTORY_ROUNDS * 2))

        history.value = nextHistory.slice(-HISTORY_ROUNDS * 2)

        await recordRound(question, reply)

        // 广播给所有窗口：主窗借此解除挂起气泡，并联动情绪表情/动作（自己的 ask 也统一走这条路径）
        void emit(LISTEN_KEY.CHAT_ACTIVITY, { label: appWindow.label, emotion, motion })

        void refreshDigest(dropped)

        status.value = 'talking'

        isError.value = false

        startTyping(reply, options?.hold === true)

        startMouth()

        return reply
      } catch (err) {
        logError(isString(err) ? err : JSON.stringify(err))

        status.value = 'talking'

        isError.value = true

        displayText.value = i18n.global.t('pages.main.chat.error')

        scheduleHide()
      }
    })
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

  /**
   * 渐进式工具指引（写在 system 里，与工具 schema 描述互补——实测只靠 schema 描述模型仍会选错动作，
   * 如"跑起来"选 wave；system 层再明确一次语义映射才稳）。
   */
  function buildToolInstruction() {
    const names = modelStore.currentExpressions.map(item => item.name).filter(name => !NON_EMOTION_EXPRESSIONS.has(name))
    if (!names.length) return ''
    return `\n\n（你有两个工具控制自己的表情和动作，规则：
① 每轮回复都要调用 set_expression，从这些表情里选最贴合心情的：${names.join('、')}。
② 博士要求你表演动作、或语境非常合适时调用 play_motion，语义严格对应：${MOTION_CHOICES.map(m => `${m.desc.split('。')[0]}→${m.id}`).join('；')}。没有贴切的就不调用，不要硬选。
③ 工具调用不代替说话——每轮都要正常回复一两句话。）`
  }

  /** Anthropic tools schema（表情 enum 动态来自当前模型注册表） */
  function buildTools() {
    const names = modelStore.currentExpressions.map(item => item.name).filter(name => !NON_EMOTION_EXPRESSIONS.has(name))
    if (!names.length) return undefined

    return [
      {
        name: 'set_expression',
        description: `改变脸上的表情（几秒后自动恢复）。每轮回复都应调用一次，选最贴合当下心情的表情。可选：${names.join('、')}`,
        input_schema: {
          type: 'object',
          properties: { expression: { type: 'string', description: '表情名', enum: names } },
          required: ['expression'],
        },
      },
      {
        name: 'play_motion',
        description: `做一个全身动作，仅在博士要求表演或语境非常合适时调用。动作语义：${MOTION_CHOICES.map(m => `${m.id}=${m.desc}`).join('；')}`,
        input_schema: {
          type: 'object',
          properties: { motion: { type: 'string', description: '动作 id', enum: MOTION_CHOICES.map(m => m.id) } },
          required: ['motion'],
        },
      },
    ]
  }

  /** 按名字播表情（表情枚举来自主窗加载模型后写入的 pinia，任意窗口都能查 index，但播只对有模型的窗口生效） */
  function playEmotion(name: string) {
    const index = modelStore.currentExpressions.findIndex(item => item.name === name)
    if (index >= 0) {
      live2d.setExpression(index)

      lastEmotion.value = { name, at: Date.now() }
    }
  }

  /** 按组名播动作（模型存在性由 currentMotions 校验；播只对主窗生效） */
  function playMotion(group: string) {
    const exists = modelStore.currentMotions?.some(([groupName]) => groupName === group)
    if (exists) live2d.startMotion({ group, no: 0 })
  }

  function buildProactiveInstruction(kind: 'present' | 'returned') {
    const lang = generalStore.appearance.language?.startsWith('zh') ? 'zh' : 'en'

    return PROACTIVE_INSTRUCTIONS[lang][kind]
  }

  function scheduleProactive() {
    const min = aiStore.proactive.minInterval
    const max = Math.max(aiStore.proactive.maxInterval, min)
    const minutes = min + Math.random() * (max - min)

    nextProactiveAt = Date.now() + minutes * 60_000
  }

  /**
   * 主动搭话状态机（起意与说话分离，人不在线绝不说给空气听）：
   * - 到点 + 博士在电脑前 → 立刻说
   * - 到点 + 博士不在     → 只起意（pending），等空闲回落（人回来了）那一刻再说
   */
  async function checkProactive(idleSeconds: number | null) {
    if (!aiStore.enabled || !aiStore.proactive.enabled) {
      pendingProactiveGreeting = false

      return
    }

    if (status.value !== 'idle' || inputVisible.value) return

    // null（非 Windows）拿不到空闲数据：视为博士在，按原节奏直接说
    const away = idleSeconds !== null && idleSeconds >= PROACTIVE_IDLE_SECONDS

    const back = idleSeconds === null || idleSeconds < RETURN_ACTIVE_SECONDS

    // 起意后博士回来了：立刻问候
    if (pendingProactiveGreeting && back) {
      pendingProactiveGreeting = false

      void ask(buildProactiveInstruction('returned'), { hold: true })

      return
    }

    if (Date.now() < nextProactiveAt) return

    if (away) {
      // 博士不在：只起意，回来再由上面的分支送达
      pendingProactiveGreeting = true

      scheduleProactive()

      return
    }

    void ask(buildProactiveInstruction('present'), { hold: true })
  }

  /** 跳过挂起中的主动搭话（消息已在聊天记录里，只是收起气泡） */
  function skipProactive() {
    if (status.value !== 'awaiting') return

    resetSpeech()
  }

  /** 心跳：查一次系统空闲，喂给主动搭话和空闲做梦两条链 */
  async function onIdleTick() {
    // 系统空闲查询（GetLastInputInfo，无全局钩子）；null（非 Windows）视为空闲
    const idleSeconds = await invoke<number | null>(INVOKE_KEY.GET_IDLE_SECONDS).catch(() => null)

    void dreamCheck(idleSeconds)

    await checkProactive(idleSeconds)
  }

  // 心跳/主动搭话/做梦只在主窗口跑：聊天窗只消费 ask/status，
  // 否则两套定时器各触发一份主动搭话（聊天窗那份没有气泡，纯幽灵消息）且做梦互踩
  if (!initialized) {
    initialized = true

    if (appWindow.label === WINDOW_LABEL.MAIN) {
      scheduleProactive()

      proactiveCheckTimer = setInterval(onIdleTick, PROACTIVE_CHECK_INTERVAL)

      // 恢复上次会话的最近对话（Layer 0：重启不清零）
      void loadPersistedRounds(HISTORY_ROUNDS * 2).then((messages) => {
        if (messages.length && !history.value.length) history.value = messages
      })

      // 其他窗口（聊天记录窗）来了新对话：博士已经在聊了，解除挂起/正在打的主动搭话气泡
      // （打字中 status 还是 talking，靠 holdBubble 兜住，否则打完会转 awaiting 永挂）
      useTauriListen<{ label: string, emotion?: string, motion?: string }>(LISTEN_KEY.CHAT_ACTIVITY, ({ payload }) => {
        if (aiStore.emotionEnabled) {
          if (payload.emotion) playEmotion(payload.emotion)

          if (payload.motion) playMotion(payload.motion)
        }

        if (payload.label !== appWindow.label && (status.value === 'awaiting' || holdBubble)) resetSpeech()
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
  }

  return {
    status,
    displayText,
    isError,
    inputVisible,
    ask,
    submit,
    openInput,
    skipProactive,
  }
}
