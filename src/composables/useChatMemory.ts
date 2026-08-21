import { invoke } from '@tauri-apps/api/core'
import { BaseDirectory, mkdir, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { error as logError } from '@tauri-apps/plugin-log'
import { ref } from 'vue'

import { useAiStore } from '@/stores/ai'

import { INVOKE_KEY } from '../constants'

/**
 * 兔兔的跨会话记忆（参考 OpenClaw 的记忆架构，为单人桌宠裁剪）：
 *
 * - history.jsonl  工作文件（Layer 0）：最近对话，超 4000 行轮转归档到 history-archive.jsonl
 * - diary/日期.md  每日日志：每轮对话机械追加（零 LLM，等价 OpenClaw 的 session-memory hook）
 * - digest.md      滚动摘要：8 轮窗口挤出的轮次 re-distill 进来（唯一的压缩 LLM 调用）
 * - memory.md      长期记忆：空闲"做梦"时从 diary 确定性打分晋级（零 LLM）
 * - dreams.md      做梦日记（LLM 彩蛋，仅供 UI 浏览，永不注入）
 * - recall.json    复现计数 store（晋级打分用）
 *
 * 约束（照搬 OpenClaw 的边界）：
 * - memory.md 磁盘预算 < 注入预算（给下次注入留余量）
 * - 预算裁剪只删"## 兔兔记住了"自动段，用户手写内容永不自动删
 * - 摘要质量守卫失败 → 保留旧摘要不压（宁可不动也不压丢）
 * - 污染门控：做梦/摘要产物不回流为记忆候选
 */

const DIR = 'ai-chat'

const HISTORY_FILE = `${DIR}/history.jsonl`

/** history.jsonl 轮转归档（物理瘦身；每轮对话在 diary/日期.md 里另有永久归档） */
const ARCHIVE_FILE = `${DIR}/history-archive.jsonl`

/** 超过 MAX 行时把前段挪进归档、只留最近 KEEP 行（ask 每轮都会读，轮转随读自然发生） */
const HISTORY_MAX_LINES = 4000

const HISTORY_KEEP_LINES = 2000

const DIGEST_FILE = `${DIR}/digest.md`

const MEMORY_FILE = `${DIR}/memory.md`

const DREAMS_FILE = `${DIR}/dreams.md`

const RECALL_FILE = `${DIR}/recall.json`

const FS_OPTS = { baseDir: BaseDirectory.AppData } as const

/** memory.md 磁盘预算（写入侧，超过删最旧自动段） */
const MEMORY_DISK_MAX = 1500

/** memory.md 注入预算（磁盘预算刻意小于它，防下次注入被截） */
const MEMORY_INJECT_MAX = 2000

/** digest.md 注入/磁盘预算 */
const DIGEST_MAX = 800

/** history.jsonl 载入时最多取的行数（防止文件无限增长拖慢启动） */
const HISTORY_LOAD_LINES = 200

/** 做梦：空闲判定与冷却（毫秒） */
const DREAM_IDLE_SECONDS = 5 * 60

const DREAM_COOLDOWN_MS = 6 * 60 * 60 * 1000

/** 晋级硬门限：跨天数、出现次数、总分 */
const PROMOTE_MIN_DAYS = 2

const PROMOTE_MIN_COUNT = 3

const PROMOTE_MIN_SCORE = 0.65

/** 新近度半衰期（天）：score = 0.5*频率 + 0.3*新近 + 0.2*跨度 */
const RECENCY_HALF_LIFE_DAYS = 14

/** 单次做梦最多晋级条数 */
const PROMOTE_LIMIT = 5

/** 做梦回看的日记天数 */
const DREAM_LOOKBACK_DAYS = 14

/** digest 固定分节标题（质量守卫按序校验） */
const DIGEST_SECTIONS = ['## 聊过的事', '## 博士的重要事', '## 未决话题', '## 关键细节'] as const

const PROMOTED_HEADER_RE = /^## 兔兔记住了 \(\d{4}-\d{2}-\d{2}\)$/gm

const TAINT_PATTERNS = ['兔兔记住了', 'bongocat-memory', ...DIGEST_SECTIONS, '做梦日记', '主动搭话时机', 'Proactive moment']

const DIGEST_SYSTEM_PROMPT = `你是对话压缩器。把【旧摘要】与【被挤出的对话】重新蒸馏成一份新的滚动摘要，供桌面宠物兔兔后续对话参考。要求：
- 输出固定四个小节，标题逐字为：## 聊过的事 / ## 博士的重要事 / ## 未决话题 / ## 关键细节
- 未决话题不得遗漏；博士说过的名字、日期、数字、偏好必须原样保留，不得改写或缩写
- 与旧摘要重复或已过时的内容要合并删去；全文不超过 500 字
- 只输出摘要本身，不要任何解释或额外标题`

const DREAM_DIARY_SYSTEM_PROMPT = `你在写做梦日记，用第一人称写一则。你是住在博士电脑桌面上的兔兔，性格好奇、温柔、有点古灵精怪。把当天记忆的碎片自然地织进日记：可以带一点小小的诗意、一个突然的联想、或一句俏皮话。不要出现"我在做梦""作为AI"之类的元话语，不要用任何标题或列表格式，就是一段流畅的短文，80~180字。只输出日记正文。`

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 聊天记录窗口用条目（带时间戳；旧记录无 t 字段则省略） */
export interface ChatLogEntry {
  t?: number
  role: 'user' | 'assistant'
  content: string
}

interface RecallEntry {
  snippet: string
  days: string[]
  count: number
  lastSeen: number
}

interface RecallStore {
  lastDreamAt: number
  entries: Record<string, RecallEntry>
}

// —— 模块级单例（对话记忆跨组件共享，刻意不进 Pinia：写入低频但读取高频）——
const digest = ref('')

const memory = ref('')

const dreams = ref('')

let recallStore: RecallStore = { lastDreamAt: 0, entries: {} }

let initialized = false

let initPromise: Promise<void> | undefined

let digestRefreshing = false

let dreaming = false

let lastAuditReason = ''

function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)

  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeHHMM() {
  return new Date().toTimeString().slice(0, 5)
}

async function readTextIfExists(path: string) {
  try {
    return (await readTextFile(path, FS_OPTS)).replace(/^\uFEFF/, '')
  } catch {
    return ''
  }
}

async function appendText(path: string, content: string) {
  await writeTextFile(path, content, { ...FS_OPTS, append: true })
}

/** 保头 75% + 保尾 25% 的截断（照搬 OpenClaw 的注入截断策略） */
function truncateKeepHeadTail(text: string, maxChars: number, marker: string) {
  if (text.length <= maxChars) return text

  const head = Math.floor(maxChars * 0.75)

  const tail = maxChars - head

  return `${text.slice(0, head)}\n${marker}\n${text.slice(-tail)}`
}

function truncateHead(text: string, maxChars: number) {
  if (text.length <= maxChars) return text

  return `${text.slice(0, maxChars)}\n...[已截断]...`
}

/** 归一化一行文本为复现计数的 key：去空白标点，取前 60 字符 */
function normalizeKey(line: string) {
  return line.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase().slice(0, 60)
}

/** 中文二元词滑窗（bigram）集合：真实对话不会逐字重复，靠词级重叠识别同一话题的复现 */
function shingles(text: string) {
  const norm = text.replace(/[\s\p{P}\p{S}]+/gu, '')

  const set = new Set<string>()

  for (let i = 0; i + 2 <= norm.length; i++) {
    const gram = norm.slice(i, i + 2)

    // 停用 bigram：寒暄/称谓/填充词，不参与聚类（防"兔兔陪博士"类套话互相堆积）
    if (!STOP_GRAMS.has(gram)) set.add(gram)
  }

  return set
}

const STOP_GRAMS = new Set(['兔兔', '博士', '今天', '明天', '谢谢', '你好', '哈哈', '什么', '没有', '可以', '一下', '时候', '知道', '觉得', '然后', '这样', '现在', '怎么', '怎样', '起来', '开始', '继续', '加油', '喜欢', '想要', '好吗', '好的', '没事', '继续'])

function extractPromotionKeys(memoryText: string) {
  const keys = new Set<string>()

  for (const match of memoryText.matchAll(/<!-- bongocat-memory:([^>]+) -->/g)) {
    keys.add(match[1])
  }

  return keys
}

/** 把 memory.md 拆成 [用户手写部分, 自动晋级段[]]（自动段 = "## 兔兔记住了 (日期)" 起） */
function splitPromotedBlocks(memoryText: string) {
  const headerIndexes = [...memoryText.matchAll(PROMOTED_HEADER_RE)].map(match => match.index)

  if (!headerIndexes.length) return { userPart: memoryText, blocks: [] as string[] }

  const userPart = memoryText.slice(0, headerIndexes[0]).trimEnd()

  const blocks = headerIndexes.map((start, i) => {
    const end = i + 1 < headerIndexes.length ? headerIndexes[i + 1] : memoryText.length

    return memoryText.slice(start, end).trimEnd()
  })

  return { userPart, blocks }
}

async function readStateFromDisk() {
  memory.value = (await readTextIfExists(MEMORY_FILE)).trim()

  digest.value = (await readTextIfExists(DIGEST_FILE)).trim()

  dreams.value = (await readTextIfExists(DREAMS_FILE)).trim()

  try {
    recallStore = JSON.parse(await readTextIfExists(RECALL_FILE)) as RecallStore
  } catch {
    recallStore = { lastDreamAt: 0, entries: {} }
  }
}

export async function initChatMemory() {
  if (initialized) return

  initPromise ??= (async () => {
    await mkdir(DIR, { ...FS_OPTS, recursive: true }).catch(() => {})

    await mkdir(`${DIR}/diary`, { ...FS_OPTS, recursive: true }).catch(() => {})

    await readStateFromDisk()

    initialized = true
  })()

  return initPromise
}

/**
 * 每轮对话前从盘上同步 memory/digest：做梦可能在其他窗口（偏好的"立即做梦"）写盘，
 * 各窗口的模块单例不会互相同步，读盘是最简单的一致性保障（文件 ~KB 级，成本可忽略）。
 */
export async function syncMemoryFromDisk() {
  if (!initialized) return initChatMemory()

  await readStateFromDisk()
}

/**
 * 跨窗口对话轮次互斥（Rust 侧 token 锁，全进程共享）：
 * 同一时刻只允许一轮 ask（读快照→LLM→落盘）在飞，后到窗口自旋等待，
 * 消除多窗口并发的读快照竞态——等价 OpenClaw 的会话所有权/文件锁语义。
 * begin 返回本次 token，end 只认 token：IPC 抖动没抢到就不会误归还（不偷别窗的锁）；
 * 持锁超 120s（webview 崩溃 finally 丢失）Rust 侧自动接管。
 * 等待超时（对端异常挂死）则降级为无锁执行：宁可冒竞态也不丢用户消息。
 */
export async function withChatRoundLock<T>(task: () => Promise<T>, timeoutMs = 75_000): Promise<T> {
  const deadline = Date.now() + timeoutMs

  let token: number | undefined

  while (Date.now() < deadline) {
    const acquired = await invoke<number | null>(INVOKE_KEY.CHAT_ROUND_BEGIN).catch(() => null)

    if (acquired !== null && acquired !== undefined) {
      token = acquired

      break
    }

    await new Promise(resolve => setTimeout(resolve, 150))
  }

  try {
    return await task()
  } finally {
    if (token !== undefined) {
      // 归还失败重试一次（归还丢失会触发 120s 偷锁自愈，但尽量主动还）
      await invoke(INVOKE_KEY.CHAT_ROUND_END, { token }).catch(() => invoke(INVOKE_KEY.CHAT_ROUND_END, { token }).catch(() => {}))
    }
  }
}

/**
 * 启动时恢复最近 N 轮对话（Layer 0：重启不清零）。
 * rotate=true 才做轮转且必须在对话锁内调用（ask 路径）：
 * 锁外轮转（启动恢复）的重写可能与锁内 recordRound 追加并发，覆盖丢行。
 */
export async function loadPersistedRounds(maxMessages: number, options?: { rotate?: boolean }) {
  await initChatMemory()

  const allLines = (await readTextIfExists(HISTORY_FILE)).split('\n').filter(Boolean)

  // 轮转：超限把前段挪进归档文件（diary 是每轮的永久归档，这里只是工作文件瘦身）。
  // 顺序取舍：先归档后重写——重写失败只是归档重复（可容忍），反过来会丢段（不可容忍）
  if (options?.rotate && allLines.length > HISTORY_MAX_LINES) {
    const kept = allLines.slice(-HISTORY_KEEP_LINES)

    const archived = allLines.slice(0, allLines.length - HISTORY_KEEP_LINES)

    try {
      await appendText(ARCHIVE_FILE, `${archived.join('\n')}\n`)

      await writeTextFile(HISTORY_FILE, `${kept.join('\n')}\n`, FS_OPTS)
    } catch {
      // 轮转失败不影响本次读取
    }
  }

  const lines = allLines.slice(-HISTORY_LOAD_LINES)

  const messages: ChatMessage[] = []

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ChatMessage

      if ((parsed.role === 'user' || parsed.role === 'assistant') && parsed.content) {
        messages.push({ role: parsed.role, content: parsed.content })
      }
    } catch {
      // 跳过损坏行
    }
  }

  return messages.slice(-maxMessages)
}

/** 聊天记录窗口用：读取完整对话日志（末尾 limit 行，含时间戳） */
export async function loadChatLog(limit = 1000): Promise<ChatLogEntry[]> {
  await initChatMemory()

  const lines = (await readTextIfExists(HISTORY_FILE)).split('\n').filter(Boolean).slice(-limit)

  const entries: ChatLogEntry[] = []

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ChatLogEntry

      if ((parsed.role === 'user' || parsed.role === 'assistant') && parsed.content) {
        entries.push({ t: parsed.t, role: parsed.role, content: parsed.content })
      }
    } catch {
      // 跳过损坏行
    }
  }

  return entries
}

/** 每轮对话落盘：history.jsonl + 今日 diary（机械追加，零 LLM） */
export async function recordRound(user: string, assistant: string) {
  if (!useAiStore().memoryEnabled) return

  await initChatMemory()

  const line = (msg: ChatMessage) => `${JSON.stringify({ t: Date.now(), ...msg })}\n`

  await appendText(HISTORY_FILE, `${line({ role: 'user', content: user })}${line({ role: 'assistant', content: assistant })}`)

  // diary 按行消费：多行内容（粘贴）压成单行，避免续行被当独立记忆候选
  const oneline = (text: string) => text.replace(/\s+/g, ' ').trim()

  await appendText(`${DIR}/diary/${today()}.md`, `[${timeHHMM()}] 博士：${oneline(user)}\n[${timeHHMM()}] 兔兔：${oneline(assistant)}\n`)
}

/** system 组装：人设 + 长期记忆（截断注入副本）+ 滚动摘要 */
export function buildSystemPrompt(persona: string) {
  if (!useAiStore().memoryEnabled) return persona

  const parts = [persona]

  if (memory.value) {
    parts.push(`[关于博士的长期记忆]\n${truncateKeepHeadTail(memory.value, MEMORY_INJECT_MAX, '[...记忆过长已截断...]')}`)
  }

  if (digest.value) {
    parts.push(`[较早对话的滚动摘要]\n${truncateHead(digest.value, DIGEST_MAX)}`)
  }

  return parts.join('\n\n')
}

/** 从文本提取可校验的实体 token：数字串、拉丁词、中文片段 */
function extractTokens(text: string) {
  return text.match(/\d{2,}|[A-Z][\w-]{2,}|\p{Script=Han}{2,}/giu) ?? []
}

/** 质量守卫：分节齐全（按序）+ 最新用户 ask 的实体至少命中 2 个 */
function auditDigest(summary: string, dropped: ChatMessage[]) {
  let cursor = 0

  for (const section of DIGEST_SECTIONS) {
    cursor = summary.indexOf(section, cursor)

    if (cursor === -1) return { ok: false, reason: `缺少分节 ${section}` }

    cursor += section.length
  }

  const lastUser = [...dropped].reverse().find(m => m.role === 'user')

  if (!lastUser) return { ok: true, reason: '' }

  const tokens = [...new Set(extractTokens(lastUser.content))].filter(t => t.length >= 2)

  if (tokens.length < 2) return { ok: true, reason: '' }

  const hits = tokens.filter(t => summary.includes(t)).length

  if (hits < 2) return { ok: false, reason: `最新话题的实体未保留（命中 ${hits}/${tokens.length}）` }

  return { ok: true, reason: '' }
}

async function callLlm(system: string, user: string, maxTokens: number) {
  return invoke<string>(INVOKE_KEY.AI_CHAT, {
    apiUrl: useAiStore().apiUrl,
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens,
  })
}

/**
 * 窗口溢出压缩：被挤出的轮次 + 旧摘要 re-distill 成新摘要。
 * 失败重试一次，仍失败则保留旧摘要（宁可不动也不压丢）。
 */
/** 同窗快速连发时，排队等当前蒸馏完成后补跑（挤出的轮次不丢摘要机会） */
let pendingDropped: ChatMessage[] = []

export async function refreshDigest(dropped: ChatMessage[]) {
  const aiStore = useAiStore()

  if (!aiStore.memoryEnabled || !dropped.length) return

  if (digestRefreshing) {
    pendingDropped.push(...dropped)

    return
  }

  digestRefreshing = true

  try {
    await initChatMemory()

    // 以盘上最新摘要为 base 蒸馏（其他窗口可能刚写入），缩小跨窗覆盖窗口
    await readStateFromDisk()

    const baseAtStart = digest.value

    const conversation = dropped.map(m => `${m.role === 'user' ? '博士' : '兔兔'}：${m.content}`).join('\n')

    const userPrompt = `【旧摘要】\n${digest.value || '（无）'}\n\n【被挤出的对话】\n${conversation}`

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const summary = (await callLlm(DIGEST_SYSTEM_PROMPT, attempt === 0 ? userPrompt : `${userPrompt}\n\n（上次输出未通过校验：${lastAuditReason}，请修复后重新输出）`, 400)).trim()

        const audit = auditDigest(summary, dropped)

        if (!audit.ok) {
          lastAuditReason = audit.reason

          continue
        }

        // 写前查盘：别窗蒸馏期间写入过 → 双段并存保住对方贡献，下次蒸馏自带合并去重
        const currentOnDisk = (await readTextIfExists(DIGEST_FILE)).trim()

        const merged = currentOnDisk && currentOnDisk !== baseAtStart ? `${currentOnDisk}\n\n${summary}` : summary

        digest.value = truncateHead(merged, DIGEST_MAX)

        await writeTextFile(DIGEST_FILE, `${digest.value}\n`, FS_OPTS)

        return
      } catch (err) {
        logError(`refreshDigest attempt ${attempt} failed: ${String(err)}`)
      }
    }
  } finally {
    digestRefreshing = false

    if (pendingDropped.length) {
      const next = pendingDropped

      pendingDropped = []

      void refreshDigest(next)
    }
  }
}

/** 收集近 N 天 diary 的候选片段（污染门控：跳过系统自产内容） */
async function collectDiarySnippets() {
  const snippets: { day: string, text: string }[] = []

  let entries: string[] = []

  try {
    entries = (await readDir(`${DIR}/diary`, FS_OPTS)).map(e => e.name)
  } catch {
    return snippets
  }

  const cutoff = today(-DREAM_LOOKBACK_DAYS)

  for (const name of entries) {
    const day = name.replace(/\.md$/, '')

    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < cutoff) continue

    const content = await readTextIfExists(`${DIR}/diary/${day}.md`)

    for (const raw of content.split('\n')) {
      const text = raw.replace(/^\[\d{2}:\d{2}\] (博士|兔兔)：/, '').trim()

      if (text.length < 6 || text.length > 280) continue

      if (TAINT_PATTERNS.some(p => text.includes(p))) continue

      snippets.push({ day, text })
    }
  }

  return snippets
}

/** 确定性打分晋级：score = 0.5*频率 + 0.3*新近 + 0.2*跨度；硬门限 count/days/score */
function scoreEntries() {
  const now = Date.now()

  const results: { key: string, entry: RecallEntry, score: number }[] = []

  for (const [key, entry] of Object.entries(recallStore.entries)) {
    const days = entry.days.length

    if (days < PROMOTE_MIN_DAYS || entry.count < PROMOTE_MIN_COUNT) continue

    const frequency = Math.log1p(entry.count) / Math.log1p(10)

    const ageDays = (now - entry.lastSeen) / 86400000

    const recency = Math.exp(-(Math.LN2 / RECENCY_HALF_LIFE_DAYS) * ageDays)

    const spanDays = (new Date(entry.days[days - 1]).getTime() - new Date(entry.days[0]).getTime()) / 86400000

    const span = Math.min(1, spanDays / 7)

    const score = 0.5 * frequency + 0.3 * recency + 0.2 * span

    if (score >= PROMOTE_MIN_SCORE) results.push({ key, entry, score })
  }

  return results.sort((a, b) => b.score - a.score)
}

/** 写入晋级段：幂等标记防重复；超磁盘预算删最旧自动段（用户手写部分永不删） */
async function applyPromotions(promotions: { key: string, entry: RecallEntry, score: number }[]) {
  if (!promotions.length) return

  const { userPart, blocks } = splitPromotedBlocks(memory.value)

  const date = today()

  const newBlocks = promotions.map(({ key, entry, score }) => {
    return `## 兔兔记住了 (${date})\n\n<!-- bongocat-memory:${key} -->\n- ${entry.snippet} [days=${entry.days.length} count=${entry.count} score=${score.toFixed(2)}]`
  })

  let allBlocks = [...blocks, ...newBlocks]

  let total = userPart.length + allBlocks.join('\n\n').length

  while (total > MEMORY_DISK_MAX && allBlocks.length > 1) {
    total -= allBlocks[0].length

    allBlocks = allBlocks.slice(1)
  }

  memory.value = [userPart, ...allBlocks].filter(Boolean).join('\n\n')

  await writeTextFile(MEMORY_FILE, `${memory.value}\n`, FS_OPTS)
}

/**
 * 空闲做梦：摄入 diary 候选 → 更新复现计数 → 确定性打分晋级 → （有晋级时）写做梦日记。
 * 全程失败静默，绝不影响对话主流程。
 */
export async function runDream(force = false) {
  const aiStore = useAiStore()

  if (!aiStore.memoryEnabled || dreaming) return { promoted: 0 }

  if (!force) {
    if (Date.now() - recallStore.lastDreamAt < DREAM_COOLDOWN_MS) return { promoted: 0 }
  }

  dreaming = true

  try {
    await initChatMemory()

    // 跨窗安全：偏好的"立即做梦"可能在任意窗口点，先从盘取最新 recall/memory，
    // 避免陈旧 store 覆盖别窗写入 / 陈旧 memory 导致重复晋级
    await readStateFromDisk()

    const snippets = await collectDiarySnippets()

    // shingle 模糊聚类：把"同一话题的换一种说法"归并到同一计数条目
    const existing = Object.values(recallStore.entries).filter(entry => Date.now() - entry.lastSeen < 30 * 86400000)

    const shingleCache = new Map<RecallEntry, Set<string>>()

    const shOf = (entry: RecallEntry) => {
      let set = shingleCache.get(entry)

      if (!set) {
        set = shingles(entry.snippet)

        shingleCache.set(entry, set)
      }

      return set
    }

    for (const { day, text } of snippets) {
      const sh = shingles(text)

      if (!sh.size) continue

      let best: RecallEntry | undefined

      let bestShared = 0

      for (const entry of existing) {
        const esh = shOf(entry)

        const need = Math.max(3, Math.floor(Math.min(sh.size, esh.size) * 0.15))

        let shared = 0

        for (const gram of sh) {
          if (esh.has(gram)) shared++
        }

        if (shared >= need && shared > bestShared) {
          best = entry

          bestShared = shared
        }
      }

      const entry = best ?? { snippet: text, days: [], count: 0, lastSeen: 0 }

      if (!best) existing.push(entry)

      entry.count += 1

      entry.lastSeen = Date.now()

      if (!entry.days.includes(day)) entry.days.push(day)
    }

    recallStore.entries = {}

    for (const entry of existing) {
      const key = normalizeKey(entry.snippet)

      if (key) recallStore.entries[key] = entry
    }

    recallStore.lastDreamAt = Date.now()

    await writeTextFile(RECALL_FILE, JSON.stringify(recallStore), FS_OPTS)

    if (!snippets.length) return { promoted: 0 }

    const promotedKeys = extractPromotionKeys(memory.value)

    const candidates = scoreEntries().filter(({ key }) => !promotedKeys.has(key)).slice(0, PROMOTE_LIMIT)

    await applyPromotions(candidates)

    if (candidates.length) {
      const fragments = candidates.map(({ entry }) => `- ${entry.snippet}`).join('\n')

      try {
        const diary = (await callLlm(DREAM_DIARY_SYSTEM_PROMPT, `今天的记忆碎片：\n${fragments}`, 200)).trim()

        if (diary) {
          dreams.value = `${dreams.value ? `${dreams.value}\n\n` : ''}【${today()}】${diary}`

          await writeTextFile(DREAMS_FILE, `${dreams.value}\n`, FS_OPTS)
        }
      } catch (err) {
        logError(`dream diary failed: ${String(err)}`)
      }
    }

    return { promoted: candidates.length }
  } catch (err) {
    logError(`runDream failed: ${String(err)}`)

    return { promoted: 0 }
  } finally {
    dreaming = false
  }
}

/** 空闲做梦的心跳入口（由 useChat 的 60s 定时器调用） */
export async function dreamCheck(idleSeconds: number | null) {
  if (idleSeconds === null || idleSeconds < DREAM_IDLE_SECONDS) return

  await runDream()
}

// —— UI 记忆卡片接口 ——

export function getMemoryContent() {
  return memory.value
}

export async function setMemoryContent(content: string) {
  memory.value = content.trim()

  await initChatMemory()

  await writeTextFile(MEMORY_FILE, `${memory.value}\n`, FS_OPTS)
}

export function getDigestContent() {
  return digest.value
}

export function getDreamsContent() {
  return dreams.value
}

export async function clearMemory() {
  memory.value = ''

  digest.value = ''

  dreams.value = ''

  recallStore = { lastDreamAt: 0, entries: {} }

  await initChatMemory()

  await Promise.all([
    writeTextFile(MEMORY_FILE, '', FS_OPTS),
    writeTextFile(DIGEST_FILE, '', FS_OPTS),
    writeTextFile(DREAMS_FILE, '', FS_OPTS),
    writeTextFile(RECALL_FILE, JSON.stringify(recallStore), FS_OPTS),
  ])
}
