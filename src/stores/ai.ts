import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

export interface AiStore {
  /** AI 对话总开关（关闭后点击/快捷键/主动搭话全部停用） */
  enabled: boolean
  /** 唤起对话输入框的全局快捷键（Tauri 键名格式） */
  shortcut: string
  /** API 中转地址（Anthropic Messages 协议） */
  apiUrl: string
  /** 直连官方端点时的 API Key（留空走本地中转） */
  apiKey: string
  /** 模型名（直连官方端点时须与该家匹配，如智谱 glm-5.2） */
  model: string
  /** 人设 system prompt */
  systemPersona: string
  /** 跨会话记忆（diary/digest/memory 做梦链路总开关） */
  memoryEnabled: boolean
  /** 回复自动配表情（[表情名] 标签协议，主窗解析后联动 Live2D 表情） */
  emotionEnabled: boolean
  proactive: {
    /** 定时主动搭话开关 */
    enabled: boolean
    /** 间隔下限（分钟） */
    minInterval: number
    /** 间隔上限（分钟） */
    maxInterval: number
  }
}

export const DEFAULT_SYSTEM_PERSONA = '你是桌面宠物兔兔（明日方舟的阿米娅风格），住在博士的电脑桌面上。用可爱、简短、口语化的中文回复，每次只说一到两句话、不超过40个字，可以适度用颜文字或兔兔相关口癖。称呼用户为"博士"。'

export const useAiStore = defineStore('ai', () => {
  const enabled = ref(true)

  const shortcut = ref('Control+Alt+T')

  const apiUrl = ref('http://127.0.0.1:18081')

  const apiKey = ref('')

  const model = ref('glm-5.2')

  const systemPersona = ref(DEFAULT_SYSTEM_PERSONA)

  const memoryEnabled = ref(true)

  const emotionEnabled = ref(true)

  const proactive = reactive<AiStore['proactive']>({
    enabled: true,
    minInterval: 5,
    maxInterval: 12,
  })

  return {
    enabled,
    shortcut,
    apiUrl,
    apiKey,
    model,
    systemPersona,
    memoryEnabled,
    emotionEnabled,
    proactive,
  }
})
