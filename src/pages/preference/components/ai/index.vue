<script setup lang="ts">
import { Divider, Flex, Input, InputNumber, SpaceAddon, SpaceCompact, Switch, TextArea } from 'antdv-next'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { useAiStore } from '@/stores/ai'

const aiStore = useAiStore()
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
</template>
