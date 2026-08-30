import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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

export async function catalogRoutes(app: FastifyInstance) {
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
