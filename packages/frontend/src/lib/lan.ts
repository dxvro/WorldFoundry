import { systemApi } from './endpoints';
import type { HealthInfo } from './types';
import { useQuery } from './useQuery';

export function lanHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// The first address of this computer on the home network, for "join at <host>:<port>"; null until known or when there is none
export function useLanHost(): string | null {
  const health = useQuery<HealthInfo | null>(() => systemApi.health().catch(() => null), []);
  const url = (health.data?.lanUrls ?? [])[0];
  return url === undefined ? null : lanHost(url);
}
