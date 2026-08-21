<script setup lang="ts">
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Button, Divider, Flex, Input, InputNumber, message, Popconfirm, SpaceAddon, SpaceCompact, Switch, TextArea } from 'antdv-next'
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { clearMemory, getDigestContent, getDreamsContent, getMemoryContent, runDream, setMemoryContent, syncMemoryFromDisk } from '@/composables/useChatMemory'
import { useAiStore } from '@/stores/ai'

const { t } = useI18n()

const aiStore = useAiStore()

const memoryText = ref('')

const digestText = ref('')

const dreamsText = ref('')

const dreaming = ref(false)

/** 上次载入/保存的快照：textarea 有未保存编辑时聚焦刷新不覆盖（用户输入优先） */
let savedSnapshot = ''

async function refreshMemoryViews() {
  // 必须读盘同步（initChatMemory 二次调用是 no-op）：主窗做梦/晋级写盘后这里要看到最新，
  // 否则用户在陈旧 textarea 上点保存会把新记忆覆盖销毁
  await syncMemoryFromDisk()

  if (memoryText.value === savedSnapshot) {
    memoryText.value = getMemoryContent()

    savedSnapshot = memoryText.value
  }

  digestText.value = getDigestContent()

  dreamsText.value = getDreamsContent()
}

// 窗口常驻只挂载一次，重新聚焦时刷新（做梦可能在挂载后才写盘）
let unlisten: (() => void) | undefined

onMounted(async () => {
  await refreshMemoryViews()

  unlisten = await getCurrentWebviewWindow().onFocusChanged(({ payload }) => {
    if (payload) void refreshMemoryViews()
  })
})

onUnmounted(() => {
  unlisten?.()
})

async function saveMemory() {
  await setMemoryContent(memoryText.value)

  memoryText.value = getMemoryContent()

  savedSnapshot = memoryText.value

  message.success(t('pages.preference.ai.hints.memorySaved'))
}

async function onClear() {
  await clearMemory()

  memoryText.value = ''

  savedSnapshot = ''

  digestText.value = ''

  dreamsText.value = ''

  message.success(t('pages.preference.ai.hints.memorySaved'))
}

async function onDream() {
  dreaming.value = true

  try {
    const { promoted } = await runDream(true)

    await refreshMemoryViews()

    if (promoted > 0) {
      message.success(t('pages.preference.ai.hints.dreamPromoted', { count: promoted }))
    } else {
      message.info(t('pages.preference.ai.labels.dreamNoResult'))
    }
  } finally {
    dreaming.value = false
  }
}
</script>

<template>
  <ProList :title="$t('pages.preference.ai.labels.chatSettings')">
    <ProListItem
      :description="$t('pages.preference.ai.hints.enabled')"
      :title="$t('pages.preference.ai.labels.enabled')"
    >
      <Switch v-model:checked="aiStore.enabled" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.ai.hints.emotion')"
      :title="$t('pages.preference.ai.labels.emotion')"
    >
      <Switch v-model:checked="aiStore.emotionEnabled" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.ai.hints.proactive')"
      :title="$t('pages.preference.ai.labels.proactive')"
    >
      <Flex align="center">
        <Switch v-model:checked="aiStore.proactive.enabled" />

        <Flex
          align="center"
          class="overflow-hidden transition-all"
          :class="[aiStore.proactive.enabled ? 'w-52 opacity-100' : 'w-0 opacity-0']"
        >
          <Divider type="vertical" />

          <SpaceCompact>
            <InputNumber
              v-model:value="aiStore.proactive.minInterval"
              class="w-16"
              :min="1"
            />

            <SpaceAddon>~</SpaceAddon>

            <InputNumber
              v-model:value="aiStore.proactive.maxInterval"
              class="w-16"
              :min="1"
            />

            <SpaceAddon>min</SpaceAddon>
          </SpaceCompact>
        </Flex>
      </Flex>
    </ProListItem>
  </ProList>

  <ProList :title="$t('pages.preference.ai.labels.apiSettings')">
    <ProListItem
      :description="$t('pages.preference.ai.hints.apiUrl')"
      :title="$t('pages.preference.ai.labels.apiUrl')"
    >
      <Input
        v-model:value="aiStore.apiUrl"
        class="w-60"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.ai.hints.apiKey')"
      :title="$t('pages.preference.ai.labels.apiKey')"
    >
      <Input
        v-model:value="aiStore.apiKey"
        class="w-60"
        type="password"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.ai.hints.model')"
      :title="$t('pages.preference.ai.labels.model')"
    >
      <Input
        v-model:value="aiStore.model"
        class="w-60"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.ai.hints.systemPersona')"
      :title="$t('pages.preference.ai.labels.systemPersona')"
      vertical
    >
      <TextArea
        v-model:value="aiStore.systemPersona"
        :autosize="{ minRows: 3, maxRows: 8 }"
      />
    </ProListItem>
  </ProList>

  <ProList :title="$t('pages.preference.ai.labels.memorySettings')">
    <ProListItem
      :description="$t('pages.preference.ai.hints.memoryEnabled')"
      :title="$t('pages.preference.ai.labels.memoryEnabled')"
    >
      <Switch v-model:checked="aiStore.memoryEnabled" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.ai.hints.memoryContent')"
      :title="$t('pages.preference.ai.labels.memoryContent')"
      vertical
    >
      <div class="w-full flex flex-col gap-2">
        <TextArea
          v-model:value="memoryText"
          :autosize="{ minRows: 4, maxRows: 10 }"
          class="w-full"
        />

        <Flex
          gap="small"
          justify="end"
        >
          <Button
            size="small"
            @click="saveMemory"
          >
            {{ $t('pages.preference.ai.labels.save') }}
          </Button>

          <Popconfirm
            :title="$t('pages.preference.ai.hints.clearConfirm')"
            @confirm="onClear"
          >
            <Button
              danger
              size="small"
            >
              {{ $t('pages.preference.ai.labels.clear') }}
            </Button>
          </Popconfirm>

          <Button
            :loading="dreaming"
            size="small"
            @click="onDream"
          >
            {{ $t('pages.preference.ai.labels.dream') }}
          </Button>
        </Flex>
      </div>
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.ai.hints.digest')"
      :title="$t('pages.preference.ai.labels.digest')"
      vertical
    >
      <TextArea
        :autosize="{ minRows: 2, maxRows: 6 }"
        class="w-full"
        readonly
        :value="digestText"
      />
    </ProListItem>

    <ProListItem
      v-if="dreamsText"
      :description="$t('pages.preference.ai.hints.dreams')"
      :title="$t('pages.preference.ai.labels.dreams')"
      vertical
    >
      <TextArea
        :autosize="{ minRows: 2, maxRows: 6 }"
        class="w-full"
        readonly
        :value="dreamsText"
      />
    </ProListItem>
  </ProList>
</template>
