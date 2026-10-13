<script setup lang="ts">
import { onMounted, ref } from 'vue'

/**
 * POC #1 — só renderiza o chat do Typebot via API própria do Nest.
 * Sem SDK definitivo, sem tenant/protocolo. Ver plano da POC.
 *
 * O Nest é a fonte da verdade do estado do chat, endereçado por um UUID
 * (`chatId`) que fica na URL (?chat=<uuid>) — não usamos localStorage.
 * Recarregar a página com a mesma URL busca o estado de novo no servidor.
 */

const API_URL = 'http://localhost:3001'
const CHAT_QUERY_PARAM = 'chat'

type ChatMessage = { from: 'bot' | 'user'; text: string }
type ChoiceItem = { id: string; content?: string }
type BotInput = {
  type: string
  items?: ChoiceItem[]
  options?: { labels?: { placeholder?: string } }
}
type ChatStateDto = {
  chatId: string
  messages: ChatMessage[]
  input: BotInput | null
  isFinished: boolean
}

const chatId = ref<string | null>(null)
const messages = ref<ChatMessage[]>([])
const currentInput = ref<BotInput | null>(null)
const textDraft = ref('')
const isLoading = ref(false)
const isFinished = ref(false)

function applyState(state: ChatStateDto) {
  chatId.value = state.chatId
  messages.value = state.messages
  currentInput.value = state.input
  isFinished.value = state.isFinished
}

function setChatIdInUrl(id: string) {
  const url = new URL(window.location.href)
  url.searchParams.set(CHAT_QUERY_PARAM, id)
  window.history.replaceState({}, '', url)
}

async function createChat() {
  isLoading.value = true
  try {
    const res = await fetch(`${API_URL}/poc/chats`, { method: 'POST' })
    const state = (await res.json()) as ChatStateDto
    applyState(state)
    setChatIdInUrl(state.chatId)
  } finally {
    isLoading.value = false
  }
}

async function loadChat(id: string) {
  isLoading.value = true
  try {
    const res = await fetch(`${API_URL}/poc/chats/${id}`)
    if (!res.ok) {
      // uuid na URL não existe no servidor (ex.: processo do Nest reiniciou) — começa um novo chat
      await createChat()
      return
    }
    applyState((await res.json()) as ChatStateDto)
  } finally {
    isLoading.value = false
  }
}

async function send(text: string) {
  if (!chatId.value || !text.trim()) return
  isLoading.value = true
  try {
    const res = await fetch(`${API_URL}/poc/chats/${chatId.value}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    applyState((await res.json()) as ChatStateDto)
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
  const existingId = new URL(window.location.href).searchParams.get(CHAT_QUERY_PARAM)
  if (existingId) {
    loadChat(existingId)
  } else {
    createChat()
  }
})
</script>

<template>
  <main class="chat">
    <h1>POC Typebot</h1>
    <p class="session">chatId: {{ chatId ?? '—' }}</p>

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
