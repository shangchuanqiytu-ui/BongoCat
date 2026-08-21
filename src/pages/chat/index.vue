<script setup lang="ts">
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ChatLogEntry } from '@/composables/useChatMemory'

import { useChat } from '@/composables/useChat'
import { loadChatLog } from '@/composables/useChatMemory'
import { hideWindow } from '@/plugins/window'
import { useGeneralStore } from '@/stores/general'

const LOG_LIMIT = 1000

/** 主动搭话的指令行不展示（那轮对话只展示兔兔说的话） */
const PROACTIVE_PREFIXES = ['（主动搭话时机', '(Proactive moment']

const { ask, status } = useChat()

const { t } = useI18n()

const generalStore = useGeneralStore()

const entries = ref<ChatLogEntry[]>([])

const truncated = ref(false)

const sending = ref(false)

const sendFailed = ref(false)

const listRef = ref<HTMLElement>()

const inputRef = ref<HTMLInputElement>()

/** 展示条目（过滤指令行）+ 日期分隔 */
const displayList = computed(() => {
  const visible = entries.value.filter(e => !PROACTIVE_PREFIXES.some(p => e.content.startsWith(p)))

  const items: Array<{ kind: 'date', label: string } | { kind: 'msg', entry: ChatLogEntry, time: string }> = []

  let lastDay = ''

  for (const entry of visible) {
    const date = entry.t ? new Date(entry.t) : undefined

    const day = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : ''

    if (day && day !== lastDay) {
      items.push({ kind: 'date', label: day })

      lastDay = day
    }

    const time = date ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : ''

    items.push({ kind: 'msg', entry, time })
  }

  return items
})

async function refreshLog() {
  const all = await loadChatLog(LOG_LIMIT)

  truncated.value = all.length >= LOG_LIMIT

  entries.value = all

  await nextTick()

  if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight
}

async function submit() {
  const value = inputRef.value?.value.trim()

  if (!value || sending.value) return

  inputRef.value!.value = ''

  sendFailed.value = false

  sending.value = true

  try {
    const reply = await ask(value)

    // 发送失败（ask 返回 undefined）：退回输入内容，别让消息凭空消失
    if (!reply) {
      inputRef.value!.value = value

      sendFailed.value = true
    }

    await refreshLog()
  } finally {
    sending.value = false
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    hideWindow()

    return
  }

  if (event.key !== 'Enter') return

  if (event.isComposing || event.keyCode === 229) return

  void submit()
}

// 窗口常驻只挂载一次，重新打开/聚焦时刷新记录
let unlisten: (() => void) | undefined

onMounted(async () => {
  await refreshLog()

  unlisten = await getCurrentWebviewWindow().onFocusChanged(({ payload }) => {
    if (payload) {
      void refreshLog()

      nextTick(() => inputRef.value?.focus())
    }
  })
})

onUnmounted(() => {
  unlisten?.()
})
</script>

<template>
  <div class="h-screen flex flex-col">
    <!-- 标题栏（Overlay 标题栏占位 + 可拖拽区） -->
    <div
      class="shrink-0 select-none px-4 pb-2 pt-7 text-center font-medium text-sm"
      data-tauri-drag-region
    >
      {{ t('pages.chat.title') }}
    </div>

    <!-- 消息流 -->
    <div
      ref="listRef"
      class="flex flex-1 flex-col gap-2 overflow-y-auto px-4"
    >
      <div
        v-if="!displayList.length"
        class="m-auto opacity-50 text-sm"
      >
        {{ t('pages.chat.empty') }}
      </div>

      <div
        v-if="truncated"
        class="self-center opacity-40 text-xs"
      >
        {{ t('pages.chat.onlyLatest', { count: LOG_LIMIT }) }}
      </div>

      <template v-for="(item, index) in displayList">
        <div
          v-if="item.kind === 'date'"
          :key="`d-${index}`"
          class="mt-2 self-center opacity-45 text-xs"
        >
          {{ item.label }}
        </div>

        <div
          v-else-if="item.entry.role === 'assistant'"
          :key="`a-${index}`"
          class="max-w-[80%] self-start whitespace-pre-wrap b-1 px-3 py-1.5 text-sm rounded-xl rounded-bl-sm"
          :style="{
            backgroundColor: generalStore.appearance.isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.05)',
            borderColor: generalStore.appearance.isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)',
          }"
        >
          {{ item.entry.content }}
          <span
            v-if="item.time"
            class="ml-1 text-[10px] opacity-40"
          >{{ item.time }}</span>
        </div>

        <div
          v-else
          :key="`u-${index}`"
          class="max-w-[80%] self-end whitespace-pre-wrap px-3 py-1.5 text-white text-sm rounded-xl rounded-br-sm"
          style="background-color: #3b82f6"
        >
          {{ item.entry.content }}
          <span
            v-if="item.time"
            class="ml-1 text-[10px] opacity-60"
          >{{ item.time }}</span>
        </div>
      </template>

      <div
        v-if="status === 'thinking' || sending"
        class="animate-pulse self-start b-1 px-3 py-1.5 opacity-70 text-sm rounded-xl"
      >
        {{ t('pages.chat.thinking') }}
      </div>
    </div>

    <!-- 输入区 -->
    <div class="shrink-0 p-3">
      <div
        v-if="sendFailed"
        class="mb-1 px-2 text-red-5 text-xs"
      >
        {{ t('pages.main.chat.error') }}
      </div>

      <input
        ref="inputRef"
        class="w-full b-1 px-4 py-2 outline-none text-sm rounded-full"
        :placeholder="t('pages.chat.placeholder')"
        :style="{
          backgroundColor: generalStore.appearance.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
          borderColor: generalStore.appearance.isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)',
        }"
        @input="sendFailed = false"
        @keydown="handleKeydown"
      >
    </div>
  </div>
</template>
