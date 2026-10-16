export type TipoErro =
  | 'requisicaoInvalida'
  | 'naoAutorizado'
  | 'acessoNegado'
  | 'naoEncontrado'
  | 'conflito'
  | 'entidadeInvalida'
  | 'limiteExcedido';

export class ErroAplicacao extends Error {
  constructor(
    readonly tipo: TipoErro,
    readonly detalhe?: string,
  ) {
    super(detalhe ?? tipo);
    this.name = new.target.name;
  }
}

export class RequisicaoInvalidaError extends ErroAplicacao {
  constructor(mensagem?: string) {
    super('requisicaoInvalida', mensagem);
  }
}

export class NaoAutorizadoError extends ErroAplicacao {
  constructor(mensagem?: string) {
    super('naoAutorizado', mensagem);
  }
}

export class AcessoNegadoError extends ErroAplicacao {
  constructor(mensagem?: string) {
    super('acessoNegado', mensagem);
  }
}

export class NaoEncontradoError extends ErroAplicacao {
  constructor(mensagem?: string) {
    super('naoEncontrado', mensagem);
  }
}

export class ConflitoError extends ErroAplicacao {
  constructor(mensagem?: string) {
    super('conflito', mensagem);
  }
}

export class EntidadeInvalidaError extends ErroAplicacao {
  constructor(mensagem?: string) {
    super('entidadeInvalida', mensagem);
  }
}

export class LimiteExcedidoError extends ErroAplicacao {
  constructor(mensagem?: string) {
    super('limiteExcedido', mensagem);
  }
}
