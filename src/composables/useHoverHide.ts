import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEventListener } from '@vueuse/core'
import { onUnmounted, watch } from 'vue'

import { useCatStore } from '@/stores/cat'
import { inBetween } from '@/utils/is'

import { INVOKE_KEY } from '../constants'

const appWindow = getCurrentWebviewWindow()
const POLL_INTERVAL = 200

/**
 * 悬停隐藏（局部事件版，无全局键鼠钩子）：
 * mousemove 去抖延时隐藏 + 忽略光标（WebView2 不合成 window 级 mouseenter，
 * 只能以首次 mousemove 视为"进入"，后续移动不断重排延时）；
 * 隐藏回调先查光标仍在窗内才隐藏（替代不可靠的 mouseleave 取消）；
 * 隐藏后窗口收不到鼠标事件，靠 Rust get_cursor_pos 轮询检测
 * 光标离开窗口矩形再恢复。矩形在隐藏时用 Tauri API 现取
 * （appStore.windowState 依赖 move/resize 事件，窗口没动过就是空的，不可靠）。
 * 非 Windows 无该命令（返回 null）时功能不生效。
 */
export function useHoverHide() {
  const catStore = useCatStore()

  let hideTimer: ReturnType<typeof setTimeout> | undefined

  let pollTimer: ReturnType<typeof setInterval> | undefined

  let hidden = false

  // 能力缓存：null=未探测，true=支持 get_cursor_pos，false=不支持（非 Windows，功能停用）
  let cursorCapable: boolean | null = null

  // 隐藏时抓取的窗口矩形（physical px，与 get_cursor_pos 同单位）
  let hideRect: { x: number, y: number, width: number, height: number } | undefined

  function isOutsideRect(x: number, y: number) {
    if (!hideRect) return false

    const { x: winX, y: winY, width, height } = hideRect

    return !(inBetween(x, winX, winX + width) && inBetween(y, winY, winY + height))
  }

  function restore() {
    hidden = false

    hideRect = void 0

    document.body.style.setProperty('opacity', 'unset')

    appWindow.setIgnoreCursorEvents(catStore.window.passThrough)

    if (pollTimer) {
      clearInterval(pollTimer)

      pollTimer = void 0
    }
  }

  async function pollCursorOutside() {
    const pos = await invoke<[number, number] | null>(INVOKE_KEY.GET_CURSOR_POS).catch(() => null)

    if (pos === null || isOutsideRect(pos[0], pos[1])) {
      restore()
    }
  }

  async function hide() {
    hidden = true

    document.body.style.setProperty('opacity', '0')

    appWindow.setIgnoreCursorEvents(true)

    const [position, size] = await Promise.all([
      appWindow.outerPosition().catch(() => null),
      appWindow.outerSize().catch(() => null),
    ])

    if (position && size) {
      hideRect = { x: position.x, y: position.y, width: size.width, height: size.height }
    }

    // 幂等防御：重复 hide() 不泄漏旧轮询
    if (pollTimer) clearInterval(pollTimer)

    pollTimer = setInterval(() => {
      void pollCursorOutside()
    }, POLL_INTERVAL)
  }

  function handleMouseMove() {
    if (!catStore.window.hideOnHover || hidden) return

    if (cursorCapable === false) return

    const armHideTimer = () => {
      if (hideTimer) clearTimeout(hideTimer)

      hideTimer = setTimeout(async () => {
        if (!catStore.window.hideOnHover || hidden) return

        // 到时后先确认光标仍在窗内（中途移开则放弃本次隐藏，等下次 mousemove 重排）
        const current = await invoke<[number, number] | null>(INVOKE_KEY.GET_CURSOR_POS).catch(() => null)

        if (current === null || isOutsideRect(current[0], current[1])) return

        // await 期间并发回调可能已 hide()（handleMouseMove 的 hidden 检查在该窗口期失效）
        if (hidden) return

        hide()
      }, catStore.window.hideOnHoverDelay * 1000)
    }

    if (cursorCapable === true) {
      armHideTimer()

      return
    }

    // 首次事件探测能力：拿不到光标（非 Windows）则缓存 false 并停用
    void invoke<[number, number] | null>(INVOKE_KEY.GET_CURSOR_POS).then((pos) => {
      cursorCapable = pos !== null

      if (cursorCapable) armHideTimer()
    })
  }

  function handleMouseLeave() {
    // 仅隐藏前的延时窗口内会收到 leave（隐藏后事件被忽略）；取消未生效的隐藏
    if (hidden) return

    if (hideTimer) {
      clearTimeout(hideTimer)

      hideTimer = void 0
    }
  }

  function cleanup() {
    if (hideTimer) {
      clearTimeout(hideTimer)

      hideTimer = void 0
    }

    if (hidden) restore()
  }

  useEventListener(window, 'mousemove', handleMouseMove)
  useEventListener(window, 'mouseleave', handleMouseLeave)

  watch(() => catStore.window.hideOnHover, (value) => {
    if (!value) cleanup()
  })

  onUnmounted(cleanup)
}
