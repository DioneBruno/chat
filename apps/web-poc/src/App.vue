<script setup lang="ts">
import { Centrifuge } from 'centrifuge'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Chat do consumidor sobre a API pública persistente (`/public/*`).
 *
 * O NestJS é a fonte da verdade: tenant, aplicação e atendimento vêm sempre da sessão
 * (nunca do navegador). O link individual (`?t=<token>`) fica na URL; recarregar a página
 * troca o token por uma sessão e recupera o histórico completo do banco. Eventos do
 * Centrifugo são só sinais: ao recebê-los (ou ao reconectar) a página relê a API.
 *
 * Layout inspirado no WhatsApp só pra ambientar o teste — não é o visual final.
 */

const API_URL = 'http://localhost:3001'
const CENTRIFUGO_WS_URL = 'ws://localhost:8000/connection/websocket'
const LINK_PARAM = 't'
const TENANT = 'poc'
const APPLICATION = 'chat'

type Sender = 'consumer' | 'bot' | 'agent' | 'system'
type MessageContent =
  | { type: 'text'; text: string; optionId?: string }
  | { type: 'options'; text?: string; options: { id: string; label: string }[] }
  | { type: 'input'; inputType: string; text?: string }
type ChatMessage = { id: string; seq: number; sender: Sender; content: MessageContent }
type AttendanceDto = {
  id: string
  protocolNumber: string
  status: 'open' | 'closed' | 'expired'
  phase: string
  closedReason: string | null
}
type ChatStateDto = {
  attendance: AttendanceDto
  messages: ChatMessage[]
  chat: { pendingOperation: { id: string; status: string } | null; expecting: 'options' | 'input' | null }
}

const session = ref<string | null>(null)
const attendance = ref<AttendanceDto | null>(null)
const messages = ref<ChatMessage[]>([])
const chat = ref<ChatStateDto['chat']>({ pendingOperation: null, expecting: null })
const textDraft = ref('')
const isLoading = ref(false)
const errorText = ref('')
let centrifuge: Centrifuge | null = null
const messagesEl = ref<HTMLElement | null>(null)

const isFinished = computed(() => !!attendance.value && attendance.value.status !== 'open')
const pendingOperationId = computed(() => chat.value.pendingOperation?.id ?? null)
/** Só a última mensagem de opções é a etapa ativa; as anteriores ficam desabilitadas. */
const activeOptionsId = computed(() => {
  if (chat.value.expecting !== 'options') return null
  return [...messages.value].reverse().find((m) => m.content.type === 'options')?.id ?? null
})
const canType = computed(() => {
  if (!attendance.value || isFinished.value || pendingOperationId.value) return false
  if (['human', 'handoff_pending'].includes(attendance.value.phase)) return true
  return chat.value.expecting === 'input'
})

function scrollToBottom() {
  nextTick(() => {
    messagesEl.value?.scrollTo({ top: messagesEl.value.scrollHeight })
  })
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(session.value ? { Authorization: `Bearer ${session.value}` } : {}),
    },
  })
  return res
}

// Eventos do Centrifugo são só sinais: o estado vem sempre da API (fonte da verdade).
async function refreshState() {
  if (!session.value) return
  const after = messages.value.at(-1)?.seq ?? 0
  const res = await api(`/public/attendance?after=${after}`)
  if (!res.ok) return
  const state = (await res.json()) as ChatStateDto
  attendance.value = state.attendance
  chat.value = state.chat
  const known = new Set(messages.value.map((m) => m.id))
  const fresh = state.messages.filter((m) => !known.has(m.id))
  if (fresh.length) messages.value = [...messages.value, ...fresh]
  scrollToBottom()
}

async function fetchRealtimeTokens() {
  const res = await api('/public/attendance/realtime')
  return (await res.json()) as { channel: string; connectionToken: string; subscriptionToken: string }
}

async function connectRealtime() {
  centrifuge?.disconnect()
  const tokens = await fetchRealtimeTokens()
  centrifuge = new Centrifuge(CENTRIFUGO_WS_URL, {
    token: tokens.connectionToken,
    getToken: async () => (await fetchRealtimeTokens()).connectionToken,
  })
  const sub = centrifuge.newSubscription(tokens.channel, {
    token: tokens.subscriptionToken,
    getToken: async () => (await fetchRealtimeTokens()).subscriptionToken,
  })
  sub.on('publication', () => void refreshState())
  // ao (re)conectar, recupera mensagens e operações perdidas pela API
  sub.on('subscribed', () => void refreshState())
  sub.subscribe()
  centrifuge.connect()
}

function setLinkInUrl(token: string) {
  const url = new URL(window.location.href)
  url.searchParams.set(LINK_PARAM, token)
  window.history.replaceState({}, '', url)
}

/** Entra num atendimento novo (visitante anônimo) ou abre outro protocolo após o encerramento. */
async function enter(path: string, init: RequestInit) {
  const res = await api(path, init)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { session: string; linkToken: string }
  session.value = body.session
  setLinkInUrl(body.linkToken)
  messages.value = []
  await refreshState()
  void connectRealtime()
}

async function startNew() {
  await enter('/public/attendances', {
    method: 'POST',
    body: JSON.stringify({ tenant: TENANT, application: APPLICATION }),
  })
}

async function restart() {
  isLoading.value = true
  try {
    await enter('/public/attendance/restart', { method: 'POST' })
  } finally {
    isLoading.value = false
  }
}

async function loadFromLink(token: string) {
  const res = await api('/public/access/exchange', { method: 'POST', body: JSON.stringify({ token }) })
  const body = res.ok ? ((await res.json()) as { session?: string; otpRequired?: boolean }) : null
  if (!body?.session) {
    // link inválido/expirado/revogado, ou exige OTP (canal de envio ainda pendente): recomeça
    errorText.value = body?.otpRequired ? 'Este atendimento exige código de acesso.' : ''
    if (!body?.otpRequired) await startNew()
    return
  }
  session.value = body.session
  await refreshState()
  void connectRealtime()
}

async function send(text: string, optionId?: string) {
  if (!session.value || !text.trim()) return
  isLoading.value = true
  errorText.value = ''
  try {
    const res = await api('/public/attendance/messages', {
      method: 'POST',
      body: JSON.stringify({ text, optionId, idempotencyKey: crypto.randomUUID() }),
    })
    if (!res.ok) errorText.value = res.status === 409 ? 'Conversa encerrada.' : 'Não foi possível enviar.'
    await refreshState()
  } finally {
    isLoading.value = false
  }
}

function submitText() {
  const text = textDraft.value
  textDraft.value = ''
  send(text)
}

function selectOption(option: { id: string; label: string }) {
  send(option.label, option.id)
}

const bubbleClass = (m: ChatMessage) => (m.sender === 'consumer' ? 'user' : m.sender)

onBeforeUnmount(() => centrifuge?.disconnect())

onMounted(async () => {
  isLoading.value = true
  try {
    const token = new URL(window.location.href).searchParams.get(LINK_PARAM)
    if (token) await loadFromLink(token)
    else await startNew()
  } catch {
    errorText.value = 'Não foi possível abrir o atendimento.'
  } finally {
    isLoading.value = false
  }
})
</script>

<template>
  <div class="wa-screen">
    <header class="wa-header">
      <div class="wa-avatar">D</div>
      <div>
        <strong class="wa-title">Duxnet</strong>
        <small v-if="attendance" class="wa-protocol">Protocolo {{ attendance.protocolNumber }}</small>
      </div>
    </header>

    <div ref="messagesEl" class="wa-messages">
      <div class="wa-row center">
        <button class="wa-history-chip" type="button">Ver atendimentos anteriores</button>
      </div>

      <template v-for="m in messages" :key="m.id">
        <div v-if="m.content.type === 'text'" :class="['wa-row', bubbleClass(m)]">
          <div class="wa-bubble">{{ m.content.text }}</div>
        </div>
        <div v-else-if="m.content.type === 'options'" class="wa-row bot">
          <div class="wa-bubble wa-choices">
            <button
              v-for="option in m.content.options"
              :key="option.id"
              :disabled="m.id !== activeOptionsId || isLoading"
              @click="selectOption(option)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
      </template>

      <div v-if="pendingOperationId" class="wa-row bot">
        <div class="wa-bubble wa-typing" title="Consultando suas informações...">
          <span></span><span></span><span></span>
        </div>
        <small>Consultando suas informações...</small>
      </div>

      <div v-if="isLoading" class="wa-row bot">
        <div class="wa-bubble wa-typing">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>

    <p v-if="errorText" class="wa-finished">{{ errorText }}</p>

    <form
      v-if="canType"
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
          :placeholder="'Mensagem'"
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

    <div v-else-if="isFinished" class="wa-finished">
      <p>Conversa encerrada.</p>
      <button type="button" class="wa-new-protocol" :disabled="isLoading" @click="restart">
        Abrir novo protocolo
      </button>
    </div>
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
.wa-row.bot,
.wa-row.agent {
  justify-content: flex-start;
}
.wa-row.system {
  justify-content: center;
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
.wa-row.agent .wa-bubble {
  background: #e3f2fd;
  border-top-left-radius: 0;
}
.wa-row.system .wa-bubble {
  background: rgba(255, 255, 255, 0.7);
  color: var(--wa-text);
  font-size: 0.78rem;
  max-width: 90%;
  text-align: center;
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

.wa-protocol {
  display: block;
  opacity: 0.85;
  font-size: 0.72rem;
}

.wa-new-protocol {
  margin-top: 8px;
  padding: 10px 18px;
  border: 0;
  border-radius: 999px;
  background: var(--wa-accent, #00c896);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}

.wa-choices button:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
