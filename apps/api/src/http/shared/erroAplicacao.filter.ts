import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ErroAplicacao } from '@modules/shared/error/erroAplicacao';
import type { TipoErro } from '@modules/shared/error/erroAplicacao';
import type { Response } from 'express';

const STATUS_TOO_MANY_REQUESTS = 429;

const criarExcecaoHttp: Record<TipoErro, (detalhe?: string) => HttpException> =
  {
    requisicaoInvalida: (detalhe) => new BadRequestException(detalhe),
    naoAutorizado: (detalhe) => new UnauthorizedException(detalhe),
    acessoNegado: (detalhe) => new ForbiddenException(detalhe),
    naoEncontrado: (detalhe) => new NotFoundException(detalhe),
    conflito: (detalhe) => new ConflictException(detalhe),
    entidadeInvalida: (detalhe) => new UnprocessableEntityException(detalhe),
    limiteExcedido: (detalhe) =>
      new HttpException(detalhe ?? '', STATUS_TOO_MANY_REQUESTS),
  };

@Catch(ErroAplicacao)
export class ErroAplicacaoFilter implements ExceptionFilter {
  catch(erro: ErroAplicacao, host: ArgumentsHost) {
    const resposta = host.switchToHttp().getResponse<Response>();
    const excecao = criarExcecaoHttp[erro.tipo](erro.detalhe);
    const corpo = excecao.getResponse();
    const status = excecao.getStatus();
    resposta
      .status(status)
      .json(
        typeof corpo === 'string'
          ? { statusCode: status, message: corpo }
          : corpo,
      );
  }
}
