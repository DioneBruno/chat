import type { InjectionToken, Provider } from '@nestjs/common';

export function criarProvedor<Argumentos extends unknown[], Instancia>(
  classe: new (...argumentos: Argumentos) => Instancia,
  dependencias: InjectionToken[] = [],
): Provider {
  return {
    provide: classe,
    useFactory: (...argumentos: unknown[]) =>
      new classe(...(argumentos as Argumentos)),
    inject: dependencias,
  };
}
