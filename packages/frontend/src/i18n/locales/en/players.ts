// Must mirror locales/de/players.ts exactly (a missing or extra key is a type error).
export const players = {
  loading: 'Loading player lists …',
  loadFailed: 'The player lists could not be loaded',
  actionFailed: 'The change was not applied',
  refresh: 'Refresh',
  unsupportedTitle: 'Player lists unavailable',
  unsupported: (mcVersion: string) =>
    `Minecraft ${mcVersion} does not keep the whitelist, operators and bans as JSON files yet (that starts with version 1.7.6). These lists cannot be managed here for this version.`,
  busy: 'The server is starting or stopping. The lists can be read, but changes are only possible once it is running or stopped.',
  pending:
    'The command was sent to the server, but it has not written the change to the file yet. It will show up shortly on its own, or after you click "Refresh".',
  corrupt: (file: string) =>
    `The file ${file} is damaged, so it is shown as empty. It will not be overwritten. Repair or delete the file to edit this list here again.`,
  files: { whitelist: 'whitelist.json', ops: 'ops.json', bannedPlayers: 'banned-players.json', bannedIps: 'banned-ips.json' },

  status: {
    title: 'Status',
    modeLabel: 'Editing',
    modeLive: 'Live via the console',
    modeFile: 'Directly in the files',
    modeLiveHelp: 'The server is running: changes are applied immediately through the console.',
    modeFileHelp: 'The server is stopped: the files are edited directly and the changes apply on the next start.',
    whitelistToggle: 'Enforce whitelist',
    whitelistOn: 'Only listed players can join.',
    whitelistOff: 'The whitelist is switched off: anyone can join. The entries below are ignored.',
    whitelistRestart: 'The server is running: the switch is applied at once through the console.',
    whitelistWorld: 'The same setting (white-list) is also in the "World settings" tab.',
    whitelistFailed: 'The whitelist setting was not saved',
    offlineMode:
      "Online mode is off: names are not verified with Mojang, so anyone can log in under someone else's name. The whitelist and operators offer little protection then.",
    opLevelDefault: (level: number) => `Default level for /op: ${level}`,
  },

  online: {
    title: 'Online players',
    count: (n: number) => (n === 1 ? '1 player online' : `${n} players online`),
    offlineHint: 'The server is not online. Players can only be added from here while they are playing.',
    none: 'Nobody is online right now.',
    whitelist: 'Whitelist',
    whitelisted: 'On the whitelist',
    op: 'Op',
    isOp: 'Is an operator',
    ban: 'Ban …',
    addWhitelistLabel: (name: string) => `Add ${name} to the whitelist`,
    opLabel: (name: string) => `Make ${name} an operator`,
    banLabel: (name: string) => `Ban ${name}`,
  },

  name: {
    label: 'Player name',
    placeholder: 'e.g. Steve',
    invalid: 'Invalid name: 1 to 16 characters, only letters, digits and underscore.',
    invalidOffline: 'Invalid name: 1 to 32 visible characters without spaces, and not starting with @.',
    required: 'Please enter a player name.',
    lookupHint: 'The name is looked up at Mojang to find the UUID.',
  },
  reason: {
    label: 'Reason (optional)',
    none: 'No reason given',
  },

  whitelist: {
    title: 'Whitelist',
    description: 'Players listed here can join while the whitelist is enforced.',
    add: 'Add',
    empty: 'The whitelist is empty.',
    remove: 'Remove',
    removeLabel: (name: string) => `Remove ${name} from the whitelist`,
    count: (n: number) => (n === 1 ? '1 entry' : `${n} entries`),
  },

  ops: {
    title: 'Operators',
    description: 'Operators can run commands. The level decides which ones.',
    add: 'Make operator',
    empty: 'There are no operators.',
    levelLabel: 'Level',
    levelOption: (level: number, short: string) => `Level ${level}: ${short}`,
    levelServerDefault: (level: number) => `Level ${level}: server default`,
    bypass: 'Bypass player limit',
    bypassHelp: 'The operator can join even when the server is full.',
    liveLocked: (level: number) =>
      `While the server runs, "/op" always assigns the default level (${level}) and no player limit bypass. Other values can only be set while the server is stopped.`,
    fileOverwrite: 'If the player is already listed, the level and the player limit bypass are overwritten.',
    levels: {
      1: { short: 'Spawn protection', help: 'Can ignore the spawn protection and change blocks around the spawn.' },
      2: { short: 'Game commands', help: 'Can use most game commands, e.g. /give, /gamemode, /tp and command blocks.' },
      3: { short: 'Player management', help: 'Can also manage players, e.g. /kick, /ban and /op.' },
      4: { short: 'Full access', help: 'Can do everything, including stopping the server (/stop) and saving (/save-all).' },
    },
    levelChip: (level: number) => `Level ${level}`,
    bypassChip: 'Bypasses limit',
    remove: 'Remove op',
    removeLabel: (name: string) => `Remove operator rights from ${name}`,
  },

  bans: {
    title: 'Banned players',
    description: 'Banned players cannot join.',
    add: 'Ban',
    empty: 'No players are banned.',
    unban: 'Unban',
    unbanLabel: (name: string) => `Unban ${name}`,
    created: 'Banned on',
    source: 'By',
    expires: 'Until',
    forever: 'permanent',
  },

  banDialog: {
    title: (name: string) => `Ban ${name}?`,
    body: 'The player is banned and, if online, kicked from the server right away.',
    confirm: 'Ban',
  },

  ips: {
    title: 'Banned IP addresses',
    description: 'Connections from these addresses are refused.',
    label: 'IP address',
    placeholder: 'e.g. 203.0.113.7',
    invalid: 'Invalid IP address (IPv4 or IPv6).',
    required: 'Please enter an IP address.',
    add: 'Ban',
    empty: 'No IP addresses are banned.',
    unban: 'Unban',
    unbanLabel: (ip: string) => `Unban ${ip}`,
  },
};
