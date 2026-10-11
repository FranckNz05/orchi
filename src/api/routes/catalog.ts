import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { countryFromPhone } from '../../catalog/market.js';
import { getCountry } from '../../catalog/countries.js';
import { errors } from '../../core/errors.js';
import { paymentOptionsFor } from '../../modules/checkout.js';
import { getCoverage, listCountries } from '../../catalog/service.js';

const REGIONS = ['WEST', 'CENTRAL', 'EAST', 'NORTH', 'SOUTHERN', 'ISLANDS'] as const;
const CHANNELS = ['mobile_money', 'card', 'bank_transfer'] as const;

const countriesQuery = z.object({
  region: z.enum(REGIONS).optional(),
  /** Inclut les territoires non souverains (Sainte-Helene). Defaut : non. */
  include_territories: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

const coverageQuery = z.object({
  country: z.string().length(2, 'Code pays ISO 3166-1 alpha-2 attendu (BJ, CI, CM...).'),
  channel: z.enum(CHANNELS).optional(),
  direction: z.enum(['payin', 'payout']).optional(),
});

const optionsQuery = z.object({
  country: z.string().length(2).optional(),
  phone: z.string().min(6).max(30).optional(),
});

export async function catalogRoutes(app: FastifyInstance) {
  /**
   * Moyens de paiement réellement ouverts pour CE marchand dans un pays.
   *
   * Sert aux marchands qui construisent leur propre page de paiement : ils
   * affichent les opérateurs à leur client sans passer par la page hébergée
   * d'Afripaie. Le pays vient de `country`, ou de l'indicatif de `phone`.
   * La liste tient compte des comptes agrégateurs utilisables (les siens, puis
   * ceux d'Afripaie) : proposer un moyen qu'on ne sait pas servir ferait
   * échouer le client après son choix.
   */
  app.get('/v1/payment-options', { preHandler: app.authenticate }, async (request) => {
    const query = optionsQuery.parse(request.query);
    const def = query.country ? getCountry(query.country) : countryFromPhone(query.phone);
    if (!def) {
      throw errors.invalidRequest(
        'Pays introuvable : indiquez `country`, ou un numéro au format international (+242…).',
        'country',
      );
    }
    const auth = request.auth!;
    const options = await paymentOptionsFor(auth.merchantId, def.iso2, auth.environment);
    return {
      object: 'payment_options',
      country: def.iso2,
      currency: def.currency,
      options,
    };
  });

  /** Liste des pays couverts, avec exigence KYC et capacite de decaissement. */
  app.get('/v1/countries', { preHandler: app.authenticate }, async (request) => {
    const query = countriesQuery.parse(request.query);
    const countries = await listCountries({
      ...(query.region ? { region: query.region } : {}),
      includeTerritories: query.include_territories,
    });
    return { object: 'list', count: countries.length, data: countries };
  });

  /**
   * Detail de couverture d'un pays : quels agregateurs, quels canaux, quels
   * reseaux, et surtout `routable_now` — un pays present au catalogue n'est pas
   * un pays ou une transaction peut passer aujourd'hui.
   */
  app.get('/v1/coverage', { preHandler: app.authenticate }, async (request) => {
    const query = coverageQuery.parse(request.query);
    return getCoverage(query.country, {
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      environment: request.auth!.environment,
    });
  });
}
