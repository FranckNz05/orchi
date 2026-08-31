import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './tests/global-setup.ts',
    /**
     * Injecte AVANT le chargement des modules de test, donc avant que
     * src/core/env.ts ne lise la configuration. dotenv ne remplace pas une
     * variable deja definie : c'est bien cette valeur qui l'emporte sur .env.
     */
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'file:./test.db',
      // Les boucles de fond ne doivent jamais tourner pendant les tests : elles
      // modifieraient les transactions sous les assertions.
      WORKERS_ENABLED: 'false',
      // La suite entiere vient d'une meme adresse : les limites de production
      // (10 connexions / 5 min, 20 inscriptions / heure) la bloqueraient des le
      // troisieme fichier. Elles restent actives, simplement relevees.
      AUTH_RATE_LIMIT_MAX: '10000',
      REGISTER_RATE_LIMIT_MAX: '10000',
    },
  },
});
