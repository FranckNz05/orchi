import { env } from '../core/env.js';
import { errors } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { cinetpayProvider } from './cinetpay.js';
import { fedapayProvider } from './fedapay.js';
import { geniuspayProvider } from './geniuspay.js';
import { sandboxProvider } from './sandbox.js';
import type { PaymentProvider } from './types.js';

/**
 * Registre des adaptateurs reellement branches.
 *
 * A distinguer du catalogue : le catalogue dit qu'un agregateur DESSERT un
 * pays, le registre dit qu'Orchi sait LUI PARLER. Un agregateur present au
 * catalogue mais absent d'ici ne peut recevoir aucune transaction — c'est ce
 * que traduit le champ `routable_now` de GET /v1/coverage.
 */
const registry = new Map<string, PaymentProvider>();

export function registerProvider(provider: PaymentProvider): void {
  if (registry.has(provider.id)) {
    throw new Error(`Adaptateur deja enregistre : ${provider.id}.`);
  }
  registry.set(provider.id, provider);
}

export function getProviderAdapter(id: string): PaymentProvider | undefined {
  return registry.get(id);
}

/** Leve une erreur exploitable par le marchand plutot qu'un undefined silencieux. */
export function requireProviderAdapter(id: string): PaymentProvider {
  const provider = registry.get(id);
  if (!provider) {
    throw errors.invalidRequest(
      `Aucun adaptateur disponible pour l'agregateur "${id}".`,
      'provider',
      { available: listProviderAdapterIds() },
    );
  }
  return provider;
}

export function listProviderAdapterIds(): string[] {
  return [...registry.keys()].sort();
}

export function listProviderAdapters(): PaymentProvider[] {
  return [...registry.values()];
}

/** Reinitialise le registre. Reserve aux tests. */
export function resetRegistry(): void {
  registry.clear();
  registerBuiltInProviders();
}

/**
 * Adaptateurs disponibles dans le code, indexes par identifiant.
 *
 * Etre present ici ne suffit PAS a recevoir du trafic : seuls les agregateurs
 * listes dans PROVIDERS_ENABLED sont enregistres. FedaPay et CinetPay sont
 * ecrits d'apres la documentation publique et n'ont jamais ete confrontes a un
 * compte sandbox reel — les activer avant cette verification enverrait de
 * vraies transactions sur un contrat suppose.
 */
const AVAILABLE: Readonly<Record<string, PaymentProvider>> = {
  [sandboxProvider.id]: sandboxProvider,
  [fedapayProvider.id]: fedapayProvider,
  [cinetpayProvider.id]: cinetpayProvider,
  [geniuspayProvider.id]: geniuspayProvider,
};

function registerBuiltInProviders(): void {
  const requested = env.PROVIDERS_ENABLED.split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  for (const id of requested) {
    const provider = AVAILABLE[id];
    if (!provider) {
      logger.warn({ provider: id, available: Object.keys(AVAILABLE) }, 'Adaptateur inconnu ignore');
      continue;
    }
    registerProvider(provider);
  }
}

/** Adaptateurs presents dans le code, actives ou non. */
export function listAvailableProviderIds(): string[] {
  return Object.keys(AVAILABLE).sort();
}

registerBuiltInProviders();
