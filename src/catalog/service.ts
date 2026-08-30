import { errors } from '../core/errors.js';
import { prisma } from '../db/client.js';
import { getProviderAdapter } from '../providers/registry.js';
import type { Channel } from './coverage.js';

/**
 * Lecture du catalogue depuis la base (et non depuis les fichiers TS) : c'est
 * ce qui permet d'ouvrir un pays ou de couper un agregateur defaillant sans
 * redeploiement. Les fichiers src/catalog/*.ts restent la source versionnee,
 * rejouee par `npm run seed:catalog`.
 */

export type Direction = 'payin' | 'payout';

export interface CoverageFilters {
  channel?: Channel;
  direction?: Direction;
  /** Environnement de la cle API : en `test`, le simulateur est propose partout. */
  environment: 'test' | 'live';
}

const SANDBOX_ID = 'sandbox';

/**
 * L'adaptateur sait-il reellement traiter ce pays sur l'un de ces canaux ?
 *
 * On interroge `supports()` plutot que la seule presence au registre : c'est
 * l'adaptateur qui connait sa couverture reelle, pas le catalogue.
 */
function connectedFor(providerId: string, country: string, channels: string[]): boolean {
  const adapter = getProviderAdapter(providerId);
  if (!adapter) return false;
  return channels.some((channel) => adapter.supports(country, channel as Channel, 'payin'));
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export async function listCountries(options: { region?: string; includeTerritories?: boolean }) {
  const countries = await prisma.country.findMany({
    where: {
      enabled: true,
      ...(options.region ? { region: options.region.toUpperCase() } : {}),
      ...(options.includeTerritories ? {} : { sovereign: true }),
    },
    include: { currency: true, coverage: { where: { enabled: true } } },
    orderBy: [{ region: 'asc' }, { name: 'asc' }],
  });

  return countries.map((c) => ({
    iso2: c.iso2,
    name: c.name,
    region: c.region,
    sovereign: c.sovereign,
    currency: { code: c.currency.code, exponent: c.currency.exponent, name: c.currency.name },
    calling_code: c.callingCode,
    zones: splitCsv(c.zones),
    kyc: {
      requirement: c.kycRequirement,
      label: c.kycLabel,
      allows_individual: c.allowsIndividual,
    },
    fees: { indicative_min_bps: c.feeMinBps, indicative_max_bps: c.feeMaxBps },
    payout: { mode: c.payoutMode, note: c.payoutNote },
    provider_count: c.coverage.length,
  }));
}

export async function getCoverage(iso2: string, filters: CoverageFilters) {
  const country = await prisma.country.findUnique({
    where: { iso2: iso2.toUpperCase() },
    include: {
      currency: true,
      coverage: {
        where: { enabled: true, provider: { enabled: true } },
        include: { provider: true },
        orderBy: { priority: 'asc' },
      },
    },
  });

  if (!country) throw errors.notFound('Pays', iso2.toUpperCase());
  if (!country.enabled) throw errors.notFound('Pays', iso2.toUpperCase());

  const rules = country.coverage.filter((rule) => {
    // Le simulateur ne doit jamais apparaitre pour une cle live.
    if (rule.providerId === SANDBOX_ID && filters.environment !== 'test') return false;
    if (filters.direction === 'payin' && !rule.supportsPayin) return false;
    if (filters.direction === 'payout' && !rule.supportsPayout) return false;
    if (filters.channel && !splitCsv(rule.channels).includes(filters.channel)) return false;
    return true;
  });

  const availableChannels = [...new Set(rules.flatMap((r) => splitCsv(r.channels)))].sort();

  return {
    country: {
      iso2: country.iso2,
      name: country.name,
      region: country.region,
      sovereign: country.sovereign,
      currency: {
        code: country.currency.code,
        exponent: country.currency.exponent,
        name: country.currency.name,
      },
      calling_code: country.callingCode,
      zones: splitCsv(country.zones),
    },
    kyc: {
      requirement: country.kycRequirement,
      label: country.kycLabel,
      allows_individual: country.allowsIndividual,
    },
    fees: { indicative_min_bps: country.feeMinBps, indicative_max_bps: country.feeMaxBps },
    payout: { mode: country.payoutMode, note: country.payoutNote },
    channels: availableChannels,
    /**
     * Honnetete operationnelle : un agregateur present au catalogue n'est pas
     * un agregateur branche. La verite est le registre d'adaptateurs, pas le
     * champ `integration` du catalogue — ce dernier peut etre a jour dans les
     * donnees alors qu'aucun code ne sait parler a l'agregateur.
     */
    routable_now: rules.some((r) => connectedFor(r.providerId, country.iso2, splitCsv(r.channels))),
    providers: rules.map((r) => ({
      id: r.providerId,
      name: r.provider.name,
      type: r.provider.type,
      integration: r.provider.integration,
      /**
       * true si un adaptateur existe ET declare desservir CE pays sur au moins
       * un de ces canaux. Un adaptateur enregistre ne suffit pas : GeniusPay
       * est branche, mais sa documentation ne couvre pas le Tchad — l'annoncer
       * disponible la-bas produirait un echec au premier paiement.
       */
      connected: connectedFor(r.providerId, country.iso2, splitCsv(r.channels)),
      priority: r.priority,
      channels: splitCsv(r.channels),
      payin: r.supportsPayin,
      payout: r.supportsPayout,
      networks: splitCsv(r.networks),
      fees: {
        min_bps: r.feeMinBps ?? country.feeMinBps,
        max_bps: r.feeMaxBps ?? country.feeMaxBps,
      },
      note: r.note,
    })),
  };
}
