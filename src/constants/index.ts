export const GITHUB_LINK = 'https://github.com/ayangweb/BongoCat'

export const LISTEN_KEY = {
  SHOW_WINDOW: 'show-window',
  HIDE_WINDOW: 'hide-window',
  START_MOTION: 'start-motion',
  SET_EXPRESSION: 'set-expression',
  /** 任一窗口完成一轮对话（payload=来源窗口 label），主窗借此解除挂起的主动搭话 */
  CHAT_ACTIVITY: 'chat-activity',
}

export const INVOKE_KEY = {
  COPY_DIR: 'copy_dir',
  AI_CHAT: 'ai_chat',
  GET_IDLE_SECONDS: 'get_idle_seconds',
  GET_CURSOR_POS: 'get_cursor_pos',
  CHAT_ROUND_BEGIN: 'chat_round_begin',
  CHAT_ROUND_END: 'chat_round_end',
}

export const LANGUAGE = {
  ZH_CN: 'zh-CN',
  ZH_TW: 'zh-TW',
  EN_US: 'en-US',
  VI_VN: 'vi-VN',
  PT_BR: 'pt-BR',
} as const

export const WINDOW_LABEL = {
  MAIN: 'main',
  PREFERENCE: 'preference',
  CHAT: 'chat',
} as const
