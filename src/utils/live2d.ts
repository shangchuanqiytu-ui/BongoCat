import type { MotionInfo } from 'easy-live2d'

import { convertFileSrc } from '@tauri-apps/api/core'
import { readDir, readTextFile } from '@tauri-apps/plugin-fs'
import { Config, CubismSetting, Live2DSprite, Priority } from 'easy-live2d'
import { groupBy } from 'es-toolkit/compat'
import JSON5 from 'json5'
import { Application, Ticker } from 'pixi.js'

import type { ModelSize } from '@/composables/useModel'

import { i18n } from '@/locales'

import { join } from './path'

Config.MouseFollow = false

class Live2d {
  private app: Application | null = null
  public model: Live2DSprite | null = null

  constructor() { }

  private initApp() {
    if (this.app) return

    const view = document.getElementById('live2dCanvas') as HTMLCanvasElement

    this.app = new Application()

    return this.app.init({
      view,
      resizeTo: window,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: devicePixelRatio,
    })
  }

  public async load(path: string) {
    await this.initApp()

    this.destroy()

    const files = await readDir(path)

    const modelFile = files.find(file => file.name.endsWith('.model3.json'))

    if (!modelFile) {
      throw new Error(i18n.global.t('utils.live2d.hints.notFound'))
    }

    const modelPath = join(path, modelFile.name)

    const modelJSON = JSON5.parse(await readTextFile(modelPath))

    const modelSetting = new CubismSetting({
      modelJSON,
    })

    modelSetting.redirectPath(({ file }) => {
      return convertFileSrc(join(path, file))
    })

    this.model = new Live2DSprite({
      modelSetting,
      ticker: Ticker.shared,
    })

    this.app?.stage.addChild(this.model)

    await this.model.ready

    // 预热 idle：让首个 idle 动作进入 SDK 缓存，之后框架的待机循环同步命中缓存、
    // 不再发起 fetch，规避加载初期的网络竞态
    // （竞态曾导致 idle 循环每帧 reject，且期间所有动作/表情点击无响应）
    await this.model.startMotion({ group: 'Idle', no: 0, priority: Priority.Idle }).catch(() => {
      // 模型没有 Idle 分组时忽略（框架 idle 回归会自行跳过）
    })

    const { width, height } = this.model

    const motions = groupBy(this.model.getMotions(), 'group')
    const expressions = this.model.getExpressions()

    // 记录"空表情"（模型注册的复位表情），用于表情展示后自动清除。
    // 注册名是中文"复位"（早前英文 'reset' 的匹配在改名后失效过，自动复位静默失灵、表情僵住）
    this.resetExpressionIndex = expressions.findIndex(item => item.name === '复位' || item.name === 'reset')

    return {
      width,
      height,
      motions,
      expressions,
    }
  }

  public destroy() {
    if (!this.model) return

    this.model?.destroy()

    this.model = null
  }

  public resizeModel(modelSize: ModelSize) {
    if (!this.model) return

    const { width, height } = modelSize

    const scaleX = innerWidth / width
    const scaleY = innerHeight / height
    const scale = Math.min(scaleX, scaleY)

    this.model.scale.set(scale)
    this.model.x = innerWidth / 2
    this.model.y = innerHeight / 2
    this.model.anchor.set(0.5)
  }

  /**
   * 播放动作（name 由 group/no 拼出，上游只认 group/no，调用方无需传）。
   * - Force 优先级：动作播放中再次点击时立即切换（Normal 会因优先级判断被直接丢弃）
   * - 动作播完后框架自动 startRandomMotion(Config.MotionGroupIdle) 回归待机，
   *   前提是模型注册了 Idle 分组（兔兔已补 motion-idle）
   */
  public startMotion(motion: Omit<MotionInfo, 'name'>) {
    const context = this.model?.startMotion({
      ...motion,
      priority: Priority.Force,
    })

    // 防加载竞态期的 reject 变成 unhandled rejection（渲染期间会逐帧刷错误日志）
    context?.catch(() => { })

    return context
  }

  /** 空表情（reset）在表情列表中的 index；-1 表示模型未提供，表情将保持展示 */
  private resetExpressionIndex = -1

  /** 表情展示时长（秒），到时切回空表情清除 */
  private EXPRESSION_DURATION = 3

  private expressionResetTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 设置表情。
   * 表情是持续状态（参数保持直到被替换），展示一会儿后自动切回空表情回归默认脸。
   */
  public setExpression(index: number) {
    this.clearExpressionTimer()

    const context = this.model?.setExpression({ index })

    if (this.resetExpressionIndex >= 0 && index !== this.resetExpressionIndex) {
      this.expressionResetTimer = setTimeout(() => {
        this.model?.setExpression({ index: this.resetExpressionIndex })
      }, this.EXPRESSION_DURATION * 1000)
    }

    return context
  }

  private clearExpressionTimer() {
    if (this.expressionResetTimer) {
      clearTimeout(this.expressionResetTimer)

      this.expressionResetTimer = void 0
    }
  }

  public setMotionSoundEnabled(enabled: boolean) {
    Config.MotionSound = enabled
  }

  /** 直接设置模型参数（如说话时的 ParamMouthOpenY），覆盖优先级高于动作/表情。布尔会转 0/1（按键按下类参数） */
  public setParameterValue(id: string, value: number | boolean, weight = 1) {
    this.model?.setParameterValueById(id, Number(value), weight)
  }

  /**
   * 解除参数 override：删除持久覆盖表项。写 0 ≠ 解除——表项会以 0 每帧压住该参数，
   * 冻结后续所有动作曲线的相关通道（如说话摇摆后 ParamAngleZ 被压 0，歪头/晃身全失效）。
   * 上游无 unset API（easy-live2d ParameterOverrideMap 只有 set/apply），按内部结构删除表项。
   */
  public unsetParameterValue(id: string) {
    const sprite = this.model as unknown as {
      _model?: { _parameterOverrides?: { _byId?: { delete: (key: string) => void } } }
    } | null

    sprite?._model?._parameterOverrides?._byId?.delete(id)
  }

  /** 取参数取值范围；模型没有该参数时返回 undefined */
  public getParameterValueRange(id: string) {
    return this.model?.getParameterValueRangeById(id) ?? undefined
  }

  public setMaxFPS(fps: number) {
    Ticker.shared.maxFPS = fps
  }
}

const live2d = new Live2d()

export default live2d
