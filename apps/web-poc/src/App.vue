<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'

/**
 * POC #1 — só renderiza o chat do Typebot via API própria do Nest.
 * Sem SDK definitivo, sem tenant/protocolo. Ver plano da POC.
 *
 * O Nest é a fonte da verdade do estado do chat, endereçado por um UUID
 * (`chatId`) que fica na URL (?chat=<uuid>) — não usamos localStorage.
 * Recarregar a página com a mesma URL busca o estado de novo no servidor.
 *
 * Layout inspirado no WhatsApp só pra ambientar o teste da POC — não é o
 * visual final do produto (isso vem com o SDK/design system reais).
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
const messagesEl = ref<HTMLElement | null>(null)

function scrollToBottom() {
  nextTick(() => {
    messagesEl.value?.scrollTo({ top: messagesEl.value.scrollHeight })
  })
}

function applyState(state: ChatStateDto) {
  chatId.value = state.chatId
  messages.value = state.messages
  currentInput.value = state.input
  isFinished.value = state.isFinished
  scrollToBottom()
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
  <div class="wa-screen">
    <header class="wa-header">
      <div class="wa-avatar">D</div>
      <strong class="wa-title">Duxnet</strong>
    </header>

    <div ref="messagesEl" class="wa-messages">
      <div class="wa-row center">
        <button class="wa-history-chip" type="button">Ver atendimentos anteriores</button>
      </div>

      <div v-for="(m, i) in messages" :key="i" :class="['wa-row', m.from]">
        <div class="wa-bubble">{{ m.text }}</div>
      </div>

      <div v-if="currentInput?.type === 'choice input'" class="wa-row bot">
        <div class="wa-bubble wa-choices">
          <button v-for="item in currentInput.items" :key="item.id" @click="selectChoice(item)">
            {{ item.content }}
          </button>
        </div>
      </div>

      <div v-if="isLoading" class="wa-row bot">
        <div class="wa-bubble wa-typing">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>

    <form
      v-if="!isFinished && currentInput?.type !== 'choice input'"
      class="wa-composer"
      @submit.prevent="submitText"
    >
      <div class="wa-input-pill">
        <svg class="wa-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 14s1.5 2 4 2 4-2 4-2" />
          <line x1="9" y1="9" x2="9.01" y2="9" />
          <line x1="15" y1="9" x2="15.01" y2="9" />
        </svg>
        <input
          v-model="textDraft"
          :placeholder="currentInput?.options?.labels?.placeholder ?? 'Mensagem'"
        />
        <svg class="wa-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        <svg class="wa-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </div>
      <button type="submit" class="wa-send" :disabled="isLoading">
        <svg v-if="textDraft.trim()" class="wa-send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
        <svg v-else class="wa-send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </button>
    </form>

    <p v-else-if="isFinished" class="wa-finished">Conversa encerrada.</p>
  </div>
</template>

<style scoped>
:root {
  --wa-header-from: #00b38f;
  --wa-header-to: #00d9a6;
  --wa-bg: #eef0f6;
  --wa-bubble-in: #ffffff;
  --wa-bubble-out: #d4f5ea;
  --wa-accent: #00c896;
  --wa-text: #1c2033;
  --wa-text-muted: #667085;
}

.wa-screen {
  display: flex;
  flex-direction: column;
  height: 100vh;
  max-width: 480px;
  margin: 0 auto;
  background: var(--wa-bg);
  font-family: 'Segoe UI', Helvetica, Arial, sans-serif;
  color: var(--wa-text);
  box-shadow: 0 0 20px rgba(0, 0, 0, 0.15);
}

.wa-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: linear-gradient(90deg, var(--wa-header-from), var(--wa-header-to));
  color: white;
  padding: 0.75rem 1rem;
}
.wa-avatar {
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  flex-shrink: 0;
}
.wa-title {
  font-size: 1.05rem;
}

.wa-messages {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 1rem 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.wa-row {
  display: flex;
}
.wa-row.bot {
  justify-content: flex-start;
}
.wa-row.user {
  justify-content: flex-end;
}
.wa-row.center {
  justify-content: center;
  margin-bottom: 0.5rem;
}

.wa-history-chip {
  border: none;
  background: white;
  color: var(--wa-text);
  font-weight: 600;
  font-size: 0.85rem;
  padding: 0.55rem 1.1rem;
  border-radius: 999px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  cursor: pointer;
}

.wa-bubble {
  max-width: 75%;
  padding: 0.45rem 0.6rem;
  border-radius: 0.5rem;
  white-space: pre-wrap;
  font-size: 0.92rem;
  line-height: 1.35;
  box-shadow: 0 1px 0.5px rgba(0, 0, 0, 0.1);
}
.wa-row.bot .wa-bubble {
  background: var(--wa-bubble-in);
  border-top-left-radius: 0;
}
.wa-row.user .wa-bubble {
  background: var(--wa-bubble-out);
  border-top-right-radius: 0;
}

.wa-choices {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
.wa-choices button {
  border: none;
  background: transparent;
  color: #00a5f4;
  padding: 0.65rem 0.8rem;
  font-size: 0.92rem;
  font-weight: 500;
  text-align: center;
  cursor: pointer;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
}
.wa-choices button:first-child {
  border-top: none;
}
.wa-choices button:hover {
  background: rgba(0, 0, 0, 0.04);
}

.wa-typing {
  display: flex;
  gap: 0.25rem;
  align-items: center;
  padding: 0.6rem 0.8rem;
}
.wa-typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #aaa;
  animation: wa-blink 1.2s infinite ease-in-out;
}
.wa-typing span:nth-child(2) {
  animation-delay: 0.2s;
}
.wa-typing span:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes wa-blink {
  0%,
  80%,
  100% {
    opacity: 0.3;
  }
  40% {
    opacity: 1;
  }
}

.wa-composer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 0.75rem;
  background: white;
}
.wa-input-pill {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--wa-bg);
  border-radius: 1.5rem;
  padding: 0.5rem 0.9rem;
}
.wa-input-pill input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: 0.92rem;
  outline: none;
  min-width: 0;
}
.wa-icon {
  width: 1.3rem;
  height: 1.3rem;
  color: #98a2b3;
  flex-shrink: 0;
  cursor: pointer;
}
.wa-send {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  border: none;
  background: linear-gradient(90deg, var(--wa-header-from), var(--wa-header-to));
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}
.wa-send-icon {
  width: 1.2rem;
  height: 1.2rem;
}
.wa-send:disabled {
  opacity: 0.5;
  cursor: default;
}

.wa-finished {
  flex: 0 0 auto;
  text-align: center;
  padding: 0.75rem;
  color: var(--wa-text-muted);
  font-size: 0.85rem;
  font-style: italic;
  background: white;
}
</style>
