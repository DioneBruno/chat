<script setup lang="ts">
import { onMounted, ref } from 'vue'

/**
 * POC #1 — só renderiza o chat do Typebot via API própria do Nest.
 * Sem SDK definitivo, sem tenant/protocolo. Ver plano da POC.
 */

const API_URL = 'http://localhost:3001'
const STORAGE_KEY = 'typebot-poc-session'

type ChatMessage = { from: 'bot' | 'user'; text: string }
type ChoiceItem = { id: string; content?: string }
type BotInput = {
  type: string
  items?: ChoiceItem[]
  options?: { labels?: { placeholder?: string } }
}

const sessionId = ref<string | null>(null)
const messages = ref<ChatMessage[]>([])
const currentInput = ref<BotInput | null>(null)
const textDraft = ref('')
const isLoading = ref(false)
const isFinished = ref(false)

function extractBotText(message: any): string {
  const content = message.content
  if (content?.type === 'markdown') return content.markdown
  if (content?.type === 'richText') {
    return content.richText
      .map((block: any) => (block.children ?? []).map((c: any) => c.text ?? '').join(''))
      .join('\n')
  }
  return JSON.stringify(content)
}

function persist() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      sessionId: sessionId.value,
      messages: messages.value,
      currentInput: currentInput.value,
      isFinished: isFinished.value,
    }),
  )
}

function applyTurnResult(result: any) {
  for (const m of result.messages ?? []) {
    messages.value.push({ from: 'bot', text: extractBotText(m) })
  }
  currentInput.value = result.input ?? null
  isFinished.value = !result.input
  persist()
}

async function start() {
  isLoading.value = true
  try {
    const res = await fetch(`${API_URL}/poc/typebot/start`, { method: 'POST' })
    const result = await res.json()
    sessionId.value = result.sessionId
    applyTurnResult(result)
  } finally {
    isLoading.value = false
  }
}

async function send(text: string) {
  if (!sessionId.value || !text.trim()) return
  messages.value.push({ from: 'user', text })
  persist()
  isLoading.value = true
  try {
    const res = await fetch(`${API_URL}/poc/typebot/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId.value, text }),
    })
    const result = await res.json()
    applyTurnResult(result)
  } finally {
    isLoading.value = false
  }
}

function submitText() {
  const text = textDraft.value
  textDraft.value = ''
  send(text)
}

function selectChoice(item: ChoiceItem) {
  send(item.content ?? '')
}

onMounted(() => {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    const parsed = JSON.parse(saved)
    sessionId.value = parsed.sessionId
    messages.value = parsed.messages
    currentInput.value = parsed.currentInput
    isFinished.value = parsed.isFinished
  } else {
    start()
  }
})
</script>

<template>
  <main class="chat">
    <h1>POC Typebot</h1>
    <p class="session">sessionId: {{ sessionId ?? '—' }}</p>

    <div class="messages">
      <div v-for="(m, i) in messages" :key="i" :class="['bubble', m.from]">
        {{ m.text }}
      </div>
      <div v-if="isLoading" class="bubble bot loading">...</div>
    </div>

    <div v-if="currentInput?.type === 'choice input'" class="choices">
      <button v-for="item in currentInput.items" :key="item.id" @click="selectChoice(item)">
        {{ item.content }}
      </button>
    </div>

    <form v-else-if="!isFinished" class="composer" @submit.prevent="submitText">
      <input
        v-model="textDraft"
        :placeholder="currentInput?.options?.labels?.placeholder ?? 'Digite sua mensagem'"
      />
      <button type="submit">Enviar</button>
    </form>

    <p v-else class="finished">Conversa encerrada.</p>
  </main>
</template>

<style scoped>
.chat {
  max-width: 480px;
  margin: 0 auto;
  padding: 1rem;
  font-family: system-ui, sans-serif;
}
.session {
  font-size: 0.75rem;
  color: #888;
}
.messages {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 300px;
  margin: 1rem 0;
}
.bubble {
  padding: 0.5rem 0.75rem;
  border-radius: 0.75rem;
  max-width: 80%;
  white-space: pre-wrap;
}
.bubble.bot {
  background: #eee;
  align-self: flex-start;
}
.bubble.user {
  background: #4f46e5;
  color: white;
  align-self: flex-end;
}
.choices {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.composer {
  display: flex;
  gap: 0.5rem;
}
.composer input {
  flex: 1;
  padding: 0.5rem;
}
.finished {
  color: #888;
  font-style: italic;
}
</style>
