import { errors } from '../core/errors.js';
import { SCENARIO_BY_PHONE_SUFFIX, type SandboxScenario } from '../providers/sandbox.js';
import { countryFromPhone } from './market.js';

/**
 * Numeros de test.
 *
 * En environnement `test`, un marchand qui encaisse par les comptes d'Afripaie
 * tombe sur les sandbox de GeniusPay ou de Yabetoo : leur issue ne se commande
 * pas (Yabetoo reussit toujours, GeniusPay attend une validation sur sa page).
 * Impossible, avec eux, de tester un refus, un delai depasse ou un paiement qui
 * expire — precisement les cas qu'une integration doit savoir traiter.
 *
 * Un numero de test est un numero international dont la partie nationale ne
 * contient QUE des zeros, sauf le dernier chiffre, qui choisit l'issue :
 *
 *   +225 00 00 00 00 00   succes
 *   +225 00 00 00 00 01   succes apres une attente (deux interrogations)
 *   +225 00 00 00 00 02   refus (solde insuffisant)
 *   +225 00 00 00 00 03   delai depasse : issue inconnue
 *   +225 00 00 00 00 04   agregateur indisponible
 *   +225 00 00 00 00 05   quota depasse
 *   +225 00 00 00 00 06   erreur d'authentification chez l'agregateur
 *   +225 00 00 00 00 07   le client ne confirme jamais : expiration
 *
 * L'indicatif fixe le pays, donc la devise et les moyens proposes, comme pour
 * un vrai numero. Le paiement est alors confie au SIMULATEUR d'Afripaie, quel
 * que soit l'agregateur que le routage aurait choisi. Aucun numero reel n'a une
 * partie nationale nulle : il n'y a pas de collision possible.
 *
 * En `live`, un numero de test est REFUSE : il partirait chez un vrai
 * agregateur, qui le rejetterait — ou pire.
 */

export const TEST_SCENARIOS: Readonly<Record<string, { scenario: SandboxScenario; label: string }>> = {
  '0': { scenario: 'success', label: 'Succès immédiat' },
  '1': { scenario: 'slow_success', label: 'Succès après une attente (deux interrogations)' },
  '2': { scenario: 'declined', label: 'Refus : solde insuffisant' },
  '3': { scenario: 'timeout', label: 'Délai dépassé : issue inconnue, à réconcilier' },
  '4': { scenario: 'unavailable', label: 'Agrégateur indisponible' },
  '5': { scenario: 'rate_limited', label: 'Quota de l’agrégateur dépassé' },
  '6': { scenario: 'auth_error', label: 'Identifiants refusés par l’agrégateur' },
  '7': { scenario: 'expired', label: 'Le client ne confirme jamais : expiration' },
};

/** Longueur de la partie nationale, pour des exemples conformes au pays. */
const NATIONAL_LENGTH: Readonly<Record<string, number>> = {
  CI: 10, BJ: 10, SN: 9, CG: 9, ML: 8, BF: 8, NE: 8, TG: 8, GW: 9, CM: 9, GA: 8,
};

/** Scenario d'un numero de test, ou `undefined` pour un numero ordinaire. */
export function testScenarioOf(phone: string | null | undefined): SandboxScenario | undefined {
  const country = countryFromPhone(phone);
  if (!country || !phone) return undefined;
  const digits = phone.replace(/\D/g, '').replace(/^00/, '');
  const national = digits.slice(country.callingCode.length);
  if (!/^0{7,9}[0-7]$/.test(national)) return undefined;

  const scenario = TEST_SCENARIOS[national.slice(-1)]!.scenario;
  // Le simulateur lit les quatre derniers chiffres : on verifie qu'il lira bien
  // le meme scenario, sans quoi la documentation mentirait.
  if (SCENARIO_BY_PHONE_SUFFIX[national.slice(-4)] !== scenario) return undefined;
  return scenario;
}

export function isTestNumber(phone: string | null | undefined): boolean {
  return testScenarioOf(phone) !== undefined;
}

/**
 * Refuse un numero de test hors environnement de test, et dit s'il faut
 * confier l'operation au simulateur.
 */
export function simulatorFor(
  environment: 'test' | 'live',
  phone: string | null | undefined,
  param: string,
): boolean {
  if (!isTestNumber(phone)) return false;
  if (environment !== 'test') {
    throw errors.invalidRequest(
      'Numéro de test : il ne fonctionne qu’avec une clé de test (sk_test_…). En réel, utilisez un vrai numéro.',
      param,
    );
  }
  return true;
}

/** Les huit numeros de test d'un pays, pour la documentation et l'API. */
export function testNumbersFor(iso2: string, callingCode: string) {
  const length = NATIONAL_LENGTH[iso2.toUpperCase()] ?? 9;
  return Object.entries(TEST_SCENARIOS).map(([digit, { scenario, label }]) => ({
    phone: `+${callingCode}${'0'.repeat(length - 1)}${digit}`,
    scenario,
    label,
  }));
}
