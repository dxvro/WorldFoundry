export const common = {
  loading: 'Loading …',
  close: 'Close',
  cancel: 'Cancel',
  moreActions: 'More actions',
  retry: 'Try again',
  unknownError: 'Unknown error.',
  errorCode: (code: string) => `Error code: ${code}`,
  // the general disclaimer of the shell and the login page; each game adds its own where a page is about that game
  disclaimer:
    'WorldFoundry is an independent open-source project. It is not an official product of any game publisher and is not approved by or associated with Mojang, Microsoft, The Indie Stone, Coffee Stain, Studio Wildcard, Snail Games, Iron Gate, The Fun Pimps, Pocketpair, Re-Logic or Valve.',
  units: {
    underOneMinute: 'under 1 min',
    day: 'd',
    hour: 'h',
    minute: 'min',
    million: 'M',
    thousand: 'K',
  },
  serverState: {
    offline: 'Offline',
    preparing: 'Preparing',
    starting: 'Starting',
    online: 'Online',
    stopping: 'Stopping',
    crashed: 'Crashed',
  },
  installState: {
    pending: 'Waiting for installation',
    installing: 'Installing',
    installed: 'Installed',
    failed: 'Installation failed',
  },
};
