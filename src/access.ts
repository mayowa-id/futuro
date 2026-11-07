import { CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

export function validateAccessToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9._~+/-]{32,256}={0,2}$/.test(value))
    throw new Error('API_ACCESS_TOKEN must be a random token of 32–256 non-whitespace characters');
  return value;
}

export function runtimeConfig(environment: NodeJS.ProcessEnv = process.env) {
  const host = environment.HOST ?? '127.0.0.1';
  const port = Number(environment.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const apiAccessToken = validateAccessToken(environment.API_ACCESS_TOKEN);
  if ((environment.NODE_ENV === 'production' || !['127.0.0.1','localhost','::1'].includes(host)) && !apiAccessToken)
    throw new Error('Set API_ACCESS_TOKEN before running production or binding outside localhost');
  return { host, port, apiAccessToken };
}

export class AccessGuard implements CanActivate {
  private digest?: Buffer;
  constructor(token?: string) {
    const validated = validateAccessToken(token);
    this.digest = validated ? createHash('sha256').update(validated).digest() : undefined;
  }
  canActivate(context: ExecutionContext): boolean {
    if (!this.digest) return true;
    const request = context.switchToHttp().getRequest();
    if (['GET','HEAD'].includes(request.method) && ['/health','/health/ready'].includes(request.path)) return true;
    const header: unknown = request.headers.authorization;
    const token = typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header)?.[1] : undefined;
    if (!token || !timingSafeEqual(this.digest, createHash('sha256').update(token).digest())) throw new UnauthorizedException();
    return true;
  }
}
