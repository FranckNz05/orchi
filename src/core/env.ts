import 'dotenv/config';
import { z } from 'zod';

/**
 * Configuration validee au demarrage. Le processus refuse de demarrer si une
 * variable est absente ou malformee : on ne veut pas decouvrir en production
 * qu'une cle de chiffrement etait vide.
 */
const base64Key32 = z
  .string()
  .refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  }, '32 octets encodes en base64 attendus (openssl rand -base64 32)');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),

  ENCRYPTION_KEY: base64Key32,
  API_KEY_PEPPER: base64Key32,

  /**
   * URL publique de l'orchestrateur, telle que les agregateurs doivent la
   * joindre. Elle sert a construire les URL de callback : une valeur fausse ou
   * locale rend TOUTE notification entrante impossible.
   */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  /**
   * Console d'exploitation. Refusee par defaut en production : elle invite a
   * coller une cle API secrete dans un navigateur, ce qui n'est acceptable
   * qu'en local. Le dashboard marchand la remplacera par une session serveur.
   */
  CONSOLE_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),

  /** Livraison des webhooks sortants vers les marchands. */
  WEBHOOK_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Periode du balayeur de transactions non terminees. */
  SWEEPER_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Age minimal d'une tentative avant que le balayeur ne l'interroge. */
  SWEEPER_MIN_AGE_MS: z.coerce.number().int().min(1000).default(45_000),
  /** Desactive les workers (utile en test et pour les processus web purs). */
  WORKERS_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),

  /**
   * Adaptateurs agregateurs actives, separes par des virgules.
   *
   * Par defaut le simulateur SEUL. FedaPay et CinetPay sont ecrits d'apres la
   * documentation publique et n'ont jamais ete confrontes a un vrai compte
   * sandbox : les activer avant cette verification enverrait de vraies
   * transactions sur un contrat suppose. C'est un choix explicite, pas un
   * oubli de configuration.
   */
  PROVIDERS_ENABLED: z.string().default('sandbox'),

  /** Surcharges d'hote, pour les tests de contrat et un eventuel proxy. */
  FEDAPAY_BASE_URL: z.string().url().optional(),
  CINETPAY_CHECKOUT_URL: z.string().url().optional(),
  CINETPAY_TRANSFER_URL: z.string().url().optional(),
  GENIUSPAY_BASE_URL: z.string().url().optional(),

  /**
   * Taux TOTAL supporte par le marchand, en points de base (500 = 5,00 %).
   *
   * La part Orchi est le solde apres la commission de l'agregateur : le
   * marchand paie le meme taux quel que soit l'agregateur retenu par le
   * routage. Voir src/modules/pricing.ts.
   */
  PLATFORM_TOTAL_PAYIN_BPS: z.coerce.number().int().min(0).max(10000).default(500),
  PLATFORM_TOTAL_PAYOUT_BPS: z.coerce.number().int().min(0).max(10000).default(500),

  /**
   * Mode de perception de la part Orchi.
   *
   *   split    l'agregateur reverse directement la part Orchi (accord requis)
   *   on_top   la part est ajoutee au montant paye par le client final
   *   invoice  la part est constatee et facturee separement
   *
   * Ce reglage ne change PAS le calcul : il documente comment l'argent arrive
   * reellement. Le confondre avec le calcul serait la meilleure facon de
   * facturer deux fois.
   */
  PLATFORM_FEE_COLLECTION: z.enum(['split', 'on_top', 'invoice']).default('split'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(racine)'} : ${i.message}`)
      .join('\n');
    // Volontairement console.error : le logger depend de cette config.
    console.error(`Configuration invalide.\n${details}\n\nVoir .env.example`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
