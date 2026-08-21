import type { Pinia } from 'pinia'

import { invoke } from '@tauri-apps/api/core'
import { ref } from 'vue'

import { useAiStore } from '@/stores/ai'

import { INVOKE_KEY } from '../constants'

/**
 * API Key 的安全存放：Windows 凭据管理器（Rust 侧），不进 pinia——
 * pinia saveOnChange 会把 store 明文持久化到 appData。
 * 内存态 ref 供偏好输入框绑定；对话调用方直接读 .value。
 */
export const apiKey = ref('')

let loaded = false

const MIGRATED_FLAG = 'bongocat-apikey-migrated'

/**
 * 启动时调用（幂等）：读凭据管理器入内存，并把 pinia 时代残留的明文 key 迁移过去后清除。
 * pinia 持久化恢复是插件 install 后的异步动作，mount 前可能未就绪——轮询等待字段出现
 * （新用户/已迁移用户等满 2s 超时即止，只在后台、不阻塞渲染）；迁移一次性用 localStorage 标记。
 */
export async function loadApiKey(pinia?: Pinia) {
  if (loaded) return
  loaded = true

  const aiStore = useAiStore(pinia)

  if (!localStorage.getItem(MIGRATED_FLAG)) {
    for (let i = 0; i < 20 && !aiStore.apiKey; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    if (aiStore.apiKey) {
      await invoke(INVOKE_KEY.SET_API_KEY, { value: aiStore.apiKey }).catch(() => {})

      aiStore.apiKey = ''

      localStorage.setItem(MIGRATED_FLAG, '1')
    }

    // 轮询超时（restore 未完成/盘损坏）不设标记：宁可下轮再等 2s，也不能错过待迁移的明文
  }

  apiKey.value = await invoke<string | null>(INVOKE_KEY.GET_API_KEY).catch(() => null) ?? ''
}

/** 保存（空串 = 清除凭据）并更新内存态 */
export async function saveApiKey(value: string) {
  apiKey.value = value

  await invoke(INVOKE_KEY.SET_API_KEY, { value }).catch(() => {})
}
