<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useChat } from '@/composables/useChat'
import { useGeneralStore } from '@/stores/general'

const { inputVisible, submit } = useChat()
const { t } = useI18n()
const generalStore = useGeneralStore()

const inputRef = ref<HTMLInputElement>()

// 与气泡同套高对比配色（--ant-color-* 变量未开 cssVar 不存在）
const palette = computed(() => generalStore.appearance.isDark
  ? {
      bg: 'rgba(32, 34, 38, 0.95)',
      border: 'rgba(255, 255, 255, 0.16)',
      text: 'rgba(255, 255, 255, 0.92)',
      focus: '#7aa2ff',
    }
  : {
      bg: 'rgba(255, 255, 255, 0.95)',
      border: 'rgba(0, 0, 0, 0.14)',
      text: '#262a30',
      focus: '#3b82f6',
    })

watch(inputVisible, (value) => {
  if (!value) return

  nextTick(() => {
    inputRef.value?.focus()
  })
}, { immediate: true })

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    inputVisible.value = false

    return
  }

  if (event.key !== 'Enter') return

  // IME 组合中的回车（keyCode 229）不提交
  if (event.isComposing || event.keyCode === 229) return

  const value = inputRef.value?.value.trim()

  if (!value) return

  inputRef.value!.value = ''

  void submit(value)
}
</script>

<template>
  <!-- data-chat-ui 标记 + mousedown.stop：点输入框不触发窗口的点击判定/拖拽 -->
  <div
    v-if="inputVisible"
    class="absolute bottom-10% left-1/2 w-2/3 -translate-x-1/2"
    data-chat-ui
    @mousedown.stop
  >
    <input
      ref="inputRef"
      class="chat-input w-full b-1 px-4 py-2 outline-none backdrop-blur-sm text-base rounded-full shadow-lg"
      :placeholder="t('pages.main.chat.placeholder')"
      :style="{ backgroundColor: palette.bg, borderColor: palette.border, color: palette.text }"
      @keydown="handleKeydown"
    >
  </div>
</template>

<style scoped>
.chat-input::placeholder {
  color: inherit;
  opacity: 0.5;
}

.chat-input:focus {
  border-color: v-bind('palette.focus');
}
</style>
