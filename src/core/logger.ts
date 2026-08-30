import pino from 'pino';
import { env, isProduction, isTest } from './env.js';

/**
 * Les chemins ci-dessous ne doivent JAMAIS atteindre les logs : cle API du
 * marchand, credentials agregateurs, numeros de telephone complets. La
 * redaction est appliquee par pino avant serialisation.
 */
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.apiKey',
  '*.api_key',
  '*.secret',
  '*.secretKey',
  '*.password',
  '*.credentials',
  'credentials',
];

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: { paths: REDACT, censor: '[redacted]' },
  base: { service: 'orchi' },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }),
});

export type Logger = typeof logger;
