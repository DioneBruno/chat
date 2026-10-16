/** Reagenda o evento sem tratá-lo como falha (ex.: pré-condição ainda não pronta). Conta como tentativa. */
export class RetryLater extends Error {
  constructor(
    message: string,
    readonly delayMs = 1000,
  ) {
    super(message);
  }
}

/** Falha que não adianta repetir: o evento vai direto para `dead`. */
export class PermanentOutboxError extends Error {}
