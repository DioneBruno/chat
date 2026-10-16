export class Logger {
  constructor(private readonly contexto: string) {}

  log(mensagem: string) {
    console.log(`[${this.contexto}] ${mensagem}`);
  }

  warn(mensagem: string) {
    console.warn(`[${this.contexto}] ${mensagem}`);
  }

  error(mensagem: string, rastro?: string) {
    console.error(`[${this.contexto}] ${mensagem}`, rastro ?? '');
  }
}
