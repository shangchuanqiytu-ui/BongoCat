import type { ExpressionInfo, MotionInfo } from 'easy-live2d'

import { resolveResource } from '@tauri-apps/api/path'
import { filter, find } from 'es-toolkit/compat'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

import { join } from '@/utils/path'

export interface Model {
  id: string
  path: string
  isPreset: boolean
}

export const useModelStore = defineStore('model', () => {
  const modelReady = ref(true)
  const models = ref<Model[]>([])
  const currentModel = ref<Model>()
  const currentMotions = ref<Array<[string, MotionInfo[]]>>([])
  const currentExpressions = ref<ExpressionInfo[]>([])
  const shortcuts = reactive<Record<string, string>>({})

  const init = async () => {
    const modelsPath = await resolveResource('assets/models')

    // 只保留用户上传的模型，预置 standard 兔兔重新注入
    const nextModels = filter(models.value, { isPreset: false })

    nextModels.unshift({
      id: find(models.value, { isPreset: true })?.id ?? nanoid(),
      isPreset: true,
      path: join(modelsPath, 'standard'),
    })

    const matched = find(nextModels, { id: currentModel.value?.id })

    currentModel.value = matched ?? nextModels[0]

    models.value = nextModels
  }

  return {
    modelReady,
    models,
    currentModel,
    currentMotions,
    currentExpressions,
    shortcuts,
    init,
  }
})
