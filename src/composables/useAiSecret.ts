import type { Pinia } from 'pinia'

import { invoke } from '@tauri-apps/api/core'
import { ref } from 'vue'

import { useAiStore } from '@/stores/ai'

import { INVOKE_KEY } from '../constants'

/**
 * API Key 的安全存放：Windows 凭据管理器（Rust 侧），不进 pinia——
 * pinia saveOnChange 会把 store 明文持久化到 appData。
 * 内存态 ref 供偏好输入框绑定；对话调用方每轮直读命令（跨窗实时正确）。
 */
export const apiKey = ref('')

let loaded = false

const MIGRATED_FLAG = 'bongocat-apikey-migrated'

/**
 * 启动时调用（幂等）：读凭据管理器入内存，并把 pinia 时代残留的明文 key 迁移过去。
 * 必须在 aiStore.$tauri.start() 之后调用（restore 已完成，legacyKey 立即可靠，无需轮询）。
 * 迁移只在写凭据成功后清源——写失败保留明文待下轮重试，绝不丢 key；
 * 迁移标记已存在时的残留明文直接清除（凭据里已有真值，防后启动窗口把明文写回盘）。
 */
export async function loadApiKey(pinia?: Pinia) {
  if (loaded) return
  loaded = true

  const aiStore = useAiStore(pinia)

  const legacyKey = aiStore.apiKey

  if (legacyKey) {
    if (localStorage.getItem(MIGRATED_FLAG)) {
      // 其他窗口已迁移过：这是残留副本，直接清（防 saveOnChange 把明文写回盘）
      aiStore.apiKey = ''
    } else if (!apiKey.value) {
      // 用户在启动窗口期抢先保存过新 key（apiKey.value 非空）则不迁移覆盖
      const ok = await invoke(INVOKE_KEY.SET_API_KEY, { value: legacyKey }).then(() => true, () => false)

      if (ok) {
        aiStore.apiKey = ''

        localStorage.setItem(MIGRATED_FLAG, '1')
      }
    }
  }

  apiKey.value = await invoke<string | null>(INVOKE_KEY.GET_API_KEY).catch(() => null) ?? ''
}

/** 保存（空串 = 清除凭据）并更新内存态；返回是否真正落进凭据管理器 */
export async function saveApiKey(value: string) {
  apiKey.value = value

  return await invoke(INVOKE_KEY.SET_API_KEY, { value }).then(() => true, () => false)
}
