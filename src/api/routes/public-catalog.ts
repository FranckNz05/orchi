import type { FastifyInstance } from 'fastify';
import { env } from '../../core/env.js';
import { prisma } from '../../db/client.js';
import { getProviderAdapter } from '../../providers/registry.js';

/**
 * Catalogue public, sans authentification.
 *
 * Le site vitrine doit pouvoir afficher la couverture reelle sans qu'un
 * visiteur possede une cle API. Rien ici n'est sensible : ce sont les memes
 * informations que celles publiees dans la documentation commerciale.
 *
 * Ce qui n'y figure PAS, volontairement : les comptes marchands, les
 * transactions, et l'etat des disjoncteurs — qui reveleraient l'activite reelle
 * de la plateforme a n'importe qui.
 *
 * La reponse est mise en cache : c'est la page la plus consultee du site et son
 * contenu ne change qu'au rythme des deploiements de catalogue.
 */

interface PublicCatalog {
  countries: Array<{
    iso2: string;
    name: string;
    region: string;
    currency: string;
    payout_mode: string;
    kyc_requirement: string;
    allows_individual: boolean;
    fee_min_bps: number;
    provider_count: number;
    connected: boolean;
  }>;
  totals: {
    countries: number;
    providers: number;
    connected_providers: number;
    currencies: number;
    regions: Record<string, number>;
  };
  /**
   * Taux total supporte par le marchand. Publie parce que c'est la premiere
   * question qu'il se pose, et qu'une grille tarifaire cachee derriere un
   * formulaire de contact n'inspire pas confiance.
   */
  pricing: {
    total_payin_bps: number;
    total_payout_bps: number;
  };
}

let cache: { at: number; data: PublicCatalog } | null = null;
const TTL_MS = 60_000;

async function build(): Promise<PublicCatalog> {
  const [countries, providers, currencies] = await Promise.all([
    prisma.country.findMany({
      where: { enabled: true, sovereign: true },
      include: { coverage: { where: { enabled: true } } },
      orderBy: [{ region: 'asc' }, { name: 'asc' }],
    }),
    prisma.provider.findMany({ where: { enabled: true } }),
    prisma.currency.count(),
  ]);

  const regions: Record<string, number> = {};
  for (const c of countries) regions[c.region] = (regions[c.region] ?? 0) + 1;

  return {
    countries: countries.map((c) => ({
      iso2: c.iso2,
      name: c.name,
      region: c.region,
      currency: c.currencyCode,
      payout_mode: c.payoutMode,
      kyc_requirement: c.kycRequirement,
      allows_individual: c.allowsIndividual,
      fee_min_bps: c.feeMinBps,
      provider_count: c.coverage.length,
      /** true si au moins un agregateur de ce pays est reellement branche. */
      connected: c.coverage.some((r) => getProviderAdapter(r.providerId) !== undefined),
    })),
    totals: {
      countries: countries.length,
      providers: providers.length,
      // Distingue ce qui est catalogue de ce qui est branche : le site ne doit
      // pas promettre 86 integrations quand une seule repond.
      connected_providers: providers.filter((p) => getProviderAdapter(p.id) !== undefined).length,
      currencies,
      regions,
    },
    pricing: {
      total_payin_bps: env.PLATFORM_TOTAL_PAYIN_BPS,
      total_payout_bps: env.PLATFORM_TOTAL_PAYOUT_BPS,
    },
  };
}

export async function publicCatalogRoutes(app: FastifyInstance) {
  app.get('/v1/public/catalog', async (_request, reply) => {
    if (!cache || Date.now() - cache.at > TTL_MS) {
      cache = { at: Date.now(), data: await build() };
    }
    return reply.header('cache-control', 'public, max-age=60').send(cache.data);
  });
}
