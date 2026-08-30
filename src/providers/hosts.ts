/**
 * Surcharges d'hote des adaptateurs.
 *
 * Lues a chaque appel dans `process.env` et non depuis la configuration
 * validee au demarrage : c'est ce qui permet a un test de contrat de pointer
 * l'adaptateur vers un serveur simule sans recharger tout le module de
 * configuration. Les variables restent declarees dans src/core/env.ts, ou elles
 * sont validees et documentees.
 *
 * En production ces variables sont vides et l'hote officiel s'applique.
 */
export function providerHost(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && value.trim().length > 0 ? value : fallback;
}
