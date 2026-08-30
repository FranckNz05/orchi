import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../core/crypto.js';
import { env } from '../core/env.js';
import { errors } from '../core/errors.js';
import { ID_PREFIX, newId } from '../core/ids.js';
import { prisma } from '../db/client.js';
import { requireProviderAdapter } from '../providers/registry.js';
import type { ProviderContext } from '../providers/types.js';

/**
 * Comptes agregateurs des marchands (le coffre).
 *
 * En modele A, ce sont LES CLES DU MARCHAND que nous conservons. C'est le
 * principal risque de securite du produit : elles sont chiffrees en
 * AES-256-GCM, ne ressortent jamais par l'API, et ne sont dechiffrees que le
 * temps d'un appel sortant.
 */

export interface ConnectAccountInput {
  merchantId: string;
  providerId: string;
  environment: 'test' | 'live';
  credentials: Record<string, string>;
  priority?: number;
}

/**
 * URL a declarer chez l'agregateur pour ce compte.
 *
 * Le jeton n'est pas decoratif : une notification entrante n'indique pas de
 * quel marchand elle provient, donc quelles credentials utiliser pour verifier
 * sa signature. C'est l'URL elle-meme qui porte cette information.
 */
export function callbackUrlFor(providerId: string, webhookToken: string): string {
  return `${env.PUBLIC_BASE_URL}/v1/hooks/${providerId}/${webhookToken}`;
}

/** Vue exposable : les valeurs de credentials n'y figurent jamais. */
export interface ProviderAccountView {
  id: string;
  provider: string;
  environment: string;
  status: string;
  priority: number;
  credential_keys: string[];
  /** A declarer dans le tableau de bord de l'agregateur. */
  callback_url: string;
  last_used_at: string | null;
  created_at: string;
}

function toView(account: {
  id: string;
  providerId: string;
  environment: string;
  status: string;
  priority: number;
  credentials: string;
  webhookToken: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}): ProviderAccountView {
  let keys: string[] = [];
  try {
    keys = Object.keys(JSON.parse(decryptSecret(account.credentials)) as Record<string, string>).sort();
  } catch {
    keys = ['(illisible)'];
  }
  return {
    id: account.id,
    provider: account.providerId,
    environment: account.environment,
    status: account.status,
    priority: account.priority,
    // On expose les NOMS des champs, jamais les valeurs : cela suffit au
    // marchand pour verifier son integration.
    credential_keys: keys,
    callback_url: callbackUrlFor(account.providerId, account.webhookToken),
    last_used_at: account.lastUsedAt?.toISOString() ?? null,
    created_at: account.createdAt.toISOString(),
  };
}

export async function connectProviderAccount(
  input: ConnectAccountInput,
): Promise<ProviderAccountView> {
  const adapter = requireProviderAdapter(input.providerId);

  const missing = adapter.requiredCredentials.filter(
    (field) => !input.credentials[field] || input.credentials[field]!.trim() === '',
  );
  if (missing.length > 0) {
    throw errors.invalidRequest(
      `Credentials incomplets pour ${adapter.name} : ${missing.join(', ')}.`,
      'credentials',
      { required: [...adapter.requiredCredentials], missing },
    );
  }

  const encrypted = encryptSecret(JSON.stringify(input.credentials));
  const data = {
    credentials: encrypted,
    status: 'ACTIVE',
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
  };

  const account = await prisma.providerAccount.upsert({
    where: {
      merchantId_providerId_environment: {
        merchantId: input.merchantId,
        providerId: input.providerId,
        environment: input.environment,
      },
    },
    create: {
      id: newId(ID_PREFIX.providerAccount),
      merchantId: input.merchantId,
      providerId: input.providerId,
      environment: input.environment,
      // Non devinable : l'URL de callback est publique par nature, elle ne doit
      // pas permettre d'enumerer les comptes des autres marchands.
      webhookToken: randomBytes(24).toString('base64url'),
      ...data,
    },
    update: data,
  });

  return toView(account);
}

export async function listProviderAccounts(
  merchantId: string,
  environment: 'test' | 'live',
): Promise<ProviderAccountView[]> {
  const accounts = await prisma.providerAccount.findMany({
    where: { merchantId, environment },
    orderBy: [{ priority: 'asc' }, { providerId: 'asc' }],
  });
  return accounts.map(toView);
}

export async function disableProviderAccount(merchantId: string, accountId: string): Promise<void> {
  const account = await prisma.providerAccount.findFirst({ where: { id: accountId, merchantId } });
  if (!account) throw errors.notFound('Compte agregateur', accountId);
  await prisma.providerAccount.update({ where: { id: accountId }, data: { status: 'DISABLED' } });
}

/**
 * Construit le contexte d'appel d'un adaptateur.
 *
 * Seul point du code ou les credentials existent en clair. Le resultat ne doit
 * jamais etre journalise ni stocke.
 */
export async function buildProviderContext(
  providerAccountId: string,
): Promise<ProviderContext & { providerId: string; callbackUrl: string }> {
  const account = await prisma.providerAccount.findUnique({ where: { id: providerAccountId } });
  if (!account) throw errors.notFound('Compte agregateur', providerAccountId);
  if (account.status !== 'ACTIVE') {
    throw errors.invalidRequest(`Le compte ${account.providerId} est desactive.`, 'provider');
  }

  let credentials: Record<string, string>;
  try {
    credentials = JSON.parse(decryptSecret(account.credentials)) as Record<string, string>;
  } catch (e) {
    // Cle de chiffrement changee sans migration, ou donnee corrompue.
    throw errors.internal(e);
  }

  return {
    providerId: account.providerId,
    callbackUrl: callbackUrlFor(account.providerId, account.webhookToken),
    merchantId: account.merchantId,
    environment: account.environment === 'live' ? 'live' : 'test',
    credentials,
  };
}
