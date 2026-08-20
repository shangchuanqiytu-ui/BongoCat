import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: true,
  unocss: true,
  rules: {
    'antfu/if-newline': 'off',
    'style/brace-style': ['error', '1tbs'],
    'ts/no-use-before-define': 'off',
    'unused-imports/no-unused-imports': 'error',
    'vue/max-attributes-per-line': 'error',
    'vue/attributes-order': ['error', {
      alphabetical: true,
    }],
    'perfectionist/sort-imports': [
      'error',
      {
        type: 'natural',
        order: 'asc',
      },
    ],
  },
  // src-tauri/assets 是 Live2D 模型数据（cdi3/model3 等含全角空格的中文配置），不是源码
  ignores: ['**/*.toml', 'src-tauri/assets/**'],
})
