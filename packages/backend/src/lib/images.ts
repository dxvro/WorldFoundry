// Hosts the interface may load mod pictures from; the Content-Security-Policy (http/frontend.ts) allows exactly these.
export const IMAGE_HOSTS = ['https://cdn.modrinth.com', 'https://storage.ficsit.app', 'https://images.steamusercontent.com', 'https://steamuserimages-a.akamaihd.net'] as const;

// A picture URL from a mod site is only passed on when the interface may load it: https on one of IMAGE_HOSTS.
// Anything else (an empty string, another host) becomes null, so no broken image is shown.
export function allowedImageUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    const url = new URL(value);
    return (IMAGE_HOSTS as readonly string[]).includes(url.origin) ? url.href : null;
  } catch {
    return null;
  }
}
