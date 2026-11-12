import type { Route } from './types.js';

const routes: (Route & { feature: string })[] = [];

/**
 * Called once at import time by each feature's route file. Rejects a second feature claiming the
 * same method and pattern, so two parallel branches cannot silently shadow each other's routes.
 */
export function registerRoutes(feature: string, list: Route[]): void {
  for (const route of list) {
    const clash = routes.find(r => r.method === route.method && r.pattern.source === route.pattern.source);
    if (clash) throw new Error(`Route ${route.method} ${route.pattern.source} registered by ${clash.feature} and ${feature}`);
    if (!route.roles.length) throw new Error(`Route ${route.method} ${route.pattern.source} has no roles`);
    routes.push({ ...route, feature });
  }
}
export const registeredRoutes = (): readonly (Route & { feature: string })[] => routes;
