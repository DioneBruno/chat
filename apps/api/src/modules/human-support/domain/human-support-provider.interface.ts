export interface HumanConversation {
  externalConversationId: string;
  externalContactId: string;
  externalSourceId: string;
  externalAccountId: string;
  externalInboxId: string;
}

/**
 * Contrato próprio (seção 11): o Chatwoot é só a interface do atendente; o histórico
 * canônico continua no PostgreSQL da plataforma.
 */
export interface HumanSupportProvider {
  /**
   * Cria (ou recupera) contato e abre uma conversa nova para este ciclo humano.
   * `existingContact` reaproveita o contato de ciclos anteriores do mesmo protocolo.
   */
  createOrGetConversation(input: {
    tenantId: string;
    attendanceId: string;
    consumerId: string;
    displayName: string;
    existingContact?: { externalContactId: string; externalSourceId: string };
  }): Promise<HumanConversation>;

  sendMessage(input: {
    externalConversationId: string;
    /** Id interno da mensagem (ou chave do contexto), para correlação e auditoria. */
    messageId: string;
    content: string;
    /** Nota interna visível só aos atendentes (contexto mínimo permitido). */
    private?: boolean;
  }): Promise<{ externalMessageId: string }>;
}

export const HUMAN_SUPPORT_PROVIDER = Symbol('HUMAN_SUPPORT_PROVIDER');
