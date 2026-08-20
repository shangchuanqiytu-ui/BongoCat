<script setup lang="ts">
import type { MotionInfo } from 'easy-live2d'

import { emit } from '@tauri-apps/api/event'
import { Empty, Modal, Segmented } from 'antdv-next'
import { isEmpty } from 'es-toolkit/compat'
import { computed, ref } from 'vue'

import { LISTEN_KEY } from '@/constants'
import { useModelStore } from '@/stores/model'

import BehaviorItem from './components/behavior-item/index.vue'

const modelValue = defineModel<boolean>()
const modelStore = useModelStore()
const value = ref<'motion' | 'expression'>('motion')

// currentMotions 是 [组名, 动作列表] 的二元组数组（上游约定），只能过滤、不能再
// Object.entries 一层（那会得到 "0"/"1"… 数字键，点击时发出垃圾 payload 导致动作全部无效）
// Idle 组是框架待机回归机制（复位到默认姿势），待机状态下点击无视觉变化，不对外展示
const visibleMotionGroups = computed(() => {
  return (modelStore.currentMotions || []).filter(([groupName]) => groupName !== 'Idle')
})

// 动作组中文名（模型 model3.json 里的组名是英文 id，直接展示不直观）
const MOTION_GROUP_LABELS: Record<string, string> = {
  celebrate: '庆祝',
  clothoff: '脱外套',
  keyboard: '键盘',
  music: '音乐',
  weapon: '武器',
}

function getMotionShortcutId(groupName: string, index: number) {
  return `${modelStore.currentModel?.id}:motion:${groupName}:${index}`
}

function getExpressionShortcutId(index: number) {
  return `${modelStore.currentModel?.id}:expression:${index}`
}

function startMotion(motion: MotionInfo) {
  emit(LISTEN_KEY.START_MOTION, motion)
}

function setExpression(index: number) {
  emit(LISTEN_KEY.SET_EXPRESSION, index)
}
</script>

<template>
  <Modal
    v-model:open="modelValue"
    :cancel-text="false"
    centered
    :footer="null"
    force-render
    :title="$t('pages.preference.model.behaviorModal.title')"
  >
    <Segmented
      v-model:value="value"
      block
      class="mb-4"
      :options="[
        { label: $t('pages.preference.model.behaviorModal.labels.motion'), value: 'motion' },
        { label: $t('pages.preference.model.behaviorModal.labels.expression'), value: 'expression' },
      ]"
    />

    <div
      v-show="value === 'motion'"
      class="flex flex-col gap-4"
    >
      <Empty
        v-if="isEmpty(modelStore.currentMotions)"
        :image="Empty.PRESENTED_IMAGE_SIMPLE"
      />

      <template v-else>
        <div
          v-for="([groupName, motions], groupIndex) in visibleMotionGroups"
          :key="groupName"
        >
          <div class="mb-2">
            {{ MOTION_GROUP_LABELS[groupName] || groupName || $t('pages.preference.model.behaviorModal.labels.motionGroupIndex', { index: groupIndex + 1 }) }}
          </div>

          <div class="b-1 b-solid b-border rounded-lg">
            <template
              v-for="(item, index) in motions"
              :key="item.no"
            >
              <BehaviorItem
                v-model="modelStore.shortcuts[getMotionShortcutId(groupName, index)]"
                :label="motions.length === 1 ? (MOTION_GROUP_LABELS[groupName] || groupName) : item.name"
                @click="startMotion(item)"
              />
            </template>
          </div>
        </div>
      </template>
    </div>

    <div
      v-show="value === 'expression'"
      class="flex flex-col"
    >
      <Empty
        v-if="isEmpty(modelStore.currentExpressions)"
        :image="Empty.PRESENTED_IMAGE_SIMPLE"
      />

      <div class="b-1 b-solid b-border rounded-lg">
        <template
          v-for="(item, index) in modelStore.currentExpressions"
          :key="item.name"
        >
          <BehaviorItem
            v-model="modelStore.shortcuts[getExpressionShortcutId(index)]"
            :label="item.name"
            @click="setExpression(index)"
          />
        </template>
      </div>
    </div>
  </Modal>
</template>
