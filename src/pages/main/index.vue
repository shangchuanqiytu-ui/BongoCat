<script setup lang="ts">
import type { MotionInfo } from 'easy-live2d'

import { convertFileSrc } from '@tauri-apps/api/core'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { Menu, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { exists } from '@tauri-apps/plugin-fs'
import { useDebounceFn, useEventListener } from '@vueuse/core'
import { round } from 'es-toolkit'
import { computed, onUnmounted, ref, watch } from 'vue'

import { useAppMenu } from '@/composables/useAppMenu'
import { useChat } from '@/composables/useChat'
import { useHoverHide } from '@/composables/useHoverHide'
import { useKeyPress } from '@/composables/useKeyPress'
import { useModel } from '@/composables/useModel'
import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY } from '@/constants'
import { hideWindow, setAlwaysOnTop, setTaskbarVisibility, showWindow } from '@/plugins/window'
import { useAiStore } from '@/stores/ai'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general.ts'
import { useModelStore } from '@/stores/model'
import live2d from '@/utils/live2d'
import { join } from '@/utils/path'
import { isWindows } from '@/utils/platform'

import ChatBubble from './components/ChatBubble.vue'
import ChatInput from './components/ChatInput.vue'

const appWindow = getCurrentWebviewWindow()
const { modelSize, handleLoad, handleDestroy, handleResize, handleAutoFit } = useModel()
const catStore = useCatStore()
const { getBaseMenu, getExitMenu } = useAppMenu()
const modelStore = useModelStore()
const generalStore = useGeneralStore()
const resizing = ref(false)
const backgroundImagePath = ref<string>()
const aiStore = useAiStore()
const chat = useChat()

useHoverHide()

// AI 对话唤起快捷键（总开关关闭时不注册）
useKeyPress(computed(() => {
  return aiStore.enabled ? aiStore.shortcut : undefined
}), () => {
  void chat.openInput()
})

onUnmounted(handleDestroy)

const debouncedResize = useDebounceFn(async () => {
  await handleResize()

  resizing.value = false
}, 100)

useEventListener('resize', () => {
  resizing.value = true

  debouncedResize()
})

watch(() => modelStore.currentModel, async (model) => {
  if (!model) return

  await handleLoad()

  // 超大模型（如全尺寸 Live2D 角色）自动缩小到屏幕高度 45%
  await handleAutoFit()

  const path = join(model.path, 'resources', 'background.png')

  const existed = await exists(path)

  backgroundImagePath.value = existed ? convertFileSrc(path) : void 0

  modelStore.modelReady = true
}, { deep: true, immediate: true })

watch([() => catStore.window.scale, modelSize], async ([scale, modelSize]) => {
  if (!modelSize) return

  const { width, height } = modelSize

  appWindow.setSize(
    new PhysicalSize({
      width: Math.round(width * (scale / 100)),
      height: Math.round(height * (scale / 100)),
    }),
  )
}, { immediate: true })

watch(() => catStore.window.visible, async (value) => {
  value ? showWindow() : hideWindow()
})

watch(() => catStore.window.passThrough, (value) => {
  appWindow.setIgnoreCursorEvents(value)
}, { immediate: true })

watch(() => catStore.window.alwaysOnTop, setAlwaysOnTop, { immediate: true })

watch(() => generalStore.app.taskbarVisible, setTaskbarVisibility, { immediate: true })

watch(() => catStore.model.motionSound, live2d.setMotionSoundEnabled, { immediate: true })

watch(() => catStore.model.maxFPS, live2d.setMaxFPS, { immediate: true })

useTauriListen<MotionInfo>(LISTEN_KEY.START_MOTION, ({ payload }) => {
  live2d.startMotion(payload)
})

useTauriListen<number>(LISTEN_KEY.SET_EXPRESSION, ({ payload }) => {
  live2d.setExpression(payload)
})

// 点击 vs 拖拽：mousedown 只记录，按住左键位移超过阈值才 startDragging；
// 原地短按左键视为点击宠物（唤起对话）。原生拖拽期间 webview 收不到事件，无法事后测距
const CLICK_DRAG_THRESHOLD = 5
const CLICK_PRESS_MS = 500

let mouseDownInfo: { x: number, y: number, time: number } | undefined

let dragStarted = false

function handleMouseDown(event: MouseEvent) {
  if (event.button !== 0) {
    appWindow.startDragging()

    return
  }

  mouseDownInfo = { x: event.clientX, y: event.clientY, time: Date.now() }

  dragStarted = false
}

function handleMouseUp(event: MouseEvent) {
  const downInfo = mouseDownInfo

  mouseDownInfo = void 0

  if (event.button !== 0 || !downInfo) return

  const isClick = !dragStarted && Date.now() - downInfo.time < CLICK_PRESS_MS

  if (!isClick) return

  void chat.openInput()
}

async function handleContextmenu(event: MouseEvent) {
  event.preventDefault()

  if (event.shiftKey) return

  const menu = await Menu.new({
    items: [
      ...await getBaseMenu(),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      ...await getExitMenu(),
    ],
  })

  // Temporarily disable always-on-top on Windows so the context menu is not covered
  if (isWindows && catStore.window.alwaysOnTop) {
    setAlwaysOnTop(false)
  }

  await menu.popup()

  // Restore always-on-top after the menu is closed
  if (!isWindows || !catStore.window.alwaysOnTop) return

  setAlwaysOnTop(true)
}

function handleMouseMove(event: MouseEvent) {
  const { buttons, shiftKey, movementX, movementY } = event

  if (buttons === 2 && shiftKey) {
    const delta = (movementX + movementY) * 0.5
    const nextScale = Math.max(10, Math.min(catStore.window.scale + delta, 500))

    catStore.window.scale = round(nextScale)

    return
  }

  if (dragStarted || !mouseDownInfo || buttons !== 1) return

  const distance = Math.hypot(event.clientX - mouseDownInfo.x, event.clientY - mouseDownInfo.y)

  if (distance <= CLICK_DRAG_THRESHOLD) return

  dragStarted = true

  appWindow.startDragging()
}
</script>

<template>
  <!-- 外层不参与镜像/透明度：聊天气泡与输入框始终正向、清晰可见。
       近透明背景（视觉不可见）让窗口矩形进入合成器 hit-test，
       否则透明窗口收不到真实鼠标（点击/拖拽/悬停隐藏全部失效） -->
  <div class="relative size-screen overflow-hidden bg-[rgba(0,0,0,0.004)]">
    <div
      class="relative size-screen overflow-hidden children:(absolute size-full)"
      :class="{ '-scale-x-100': catStore.model.mirror }"
      :style="{
        opacity: catStore.window.opacity / 100,
        borderRadius: `${catStore.window.radius}%`,
      }"
      @contextmenu="handleContextmenu"
      @mousedown="handleMouseDown"
      @mousemove="handleMouseMove"
      @mouseup="handleMouseUp"
    >
      <img
        v-if="backgroundImagePath"
        class="object-cover"
        :src="backgroundImagePath"
      >

      <canvas id="live2dCanvas" />

      <div
        v-show="resizing || !modelStore.modelReady"
        class="flex items-center justify-center bg-black"
      >
        <span class="text-center text-[10vw] text-[#fff]">
          {{ resizing ? $t('pages.main.hints.redrawing') : $t('pages.main.hints.switching') }}
        </span>
      </div>
    </div>

    <ChatBubble />
    <ChatInput />
  </div>
</template>
