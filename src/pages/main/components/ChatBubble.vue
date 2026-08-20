<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useChat } from '@/composables/useChat'
import { useGeneralStore } from '@/stores/general'

const { status, displayText, isError } = useChat()
const { t } = useI18n()
const generalStore = useGeneralStore()

// --ant-color-* 变量未开 cssVar 不存在，桌宠悬浮在任意壁纸上需自带高对比底色
const palette = computed(() => generalStore.appearance.isDark
  ? {
      bg: 'rgba(32, 34, 38, 0.95)',
      border: 'rgba(255, 255, 255, 0.16)',
      text: 'rgba(255, 255, 255, 0.92)',
      error: '#ff8f93',
    }
  : {
      bg: 'rgba(255, 255, 255, 0.95)',
      border: 'rgba(0, 0, 0, 0.14)',
      text: '#262a30',
      error: '#e5484d',
    })
</script>

<template>
  <!-- 与镜像内容平级（不被 -scale-x-100 翻转），pointer-events-none 不挡点击/拖拽 -->
  <div
    v-if="status !== 'idle'"
    class="pointer-events-none absolute left-1/2 top-4% max-w-[85%] b-1 px-4 py-2 backdrop-blur-sm rounded-xl shadow-lg -translate-x-1/2"
    data-chat-bubble
    :style="{ backgroundColor: palette.bg, borderColor: palette.border, color: palette.text }"
  >
    <span
      v-if="status === 'thinking'"
      class="animate-pulse text-base"
    >
      {{ t('pages.main.chat.thinking') }}
    </span>

    <span
      v-else
      class="whitespace-pre-wrap leading-normal text-base"
      :style="isError ? { color: palette.error } : undefined"
    >
      {{ displayText }}
    </span>

    <!-- 气泡小尾巴 -->
    <div
      class="absolute bottom-[-6px] left-1/2 size-3 rotate-45 b-b-1 b-r-1 -translate-x-1/2"
      :style="{ backgroundColor: palette.bg, borderColor: palette.border }"
    />
  </div>
</template>
