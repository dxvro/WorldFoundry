import { useGames } from '../games/GamesProvider';
import { GameDisclaimer } from '../games/GameDisclaimer';
import { ArrowLeft, RotateCcw, ServerOff, Users } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { InstallPanel } from '../components/InstallPanel';
import { JavaProgress } from '../components/JavaProgress';
import { ActionBar, ActionFeedback, useServerActions } from '../components/ServerActions';
import { LOADER_LABEL, StatusChip } from '../components/status';
import { Button, EmptyState, ErrorNotice, LoadingBlock, Notice, cx } from '../components/ui';
import { renderOptionalRef, useI18n } from '../i18n';
import { preparingMajor } from '../lib/java';
import { Link, serverPath, useRouter, type ServerTab } from '../lib/router';
import { useLive } from '../live/LiveProvider';
import { BackupsTab } from './server/BackupsTab';
import { ConfigTab } from './server/ConfigTab';
import { ConsoleTab } from './server/ConsoleTab';
import { contentNames, ModsTab } from './server/ModsTab';
import { PlayersTab } from './server/PlayersTab';
import { StoreTab } from './server/StoreTab';
import { ZomboidSettingsTab } from './server/ZomboidSettingsTab';
import { FilesTab } from './server/FilesTab';
import { WorkshopTab } from './server/WorkshopTab';
import { FicsitTab } from './server/FicsitTab';
import { GamePlayersTab } from './server/GamePlayersTab';
import { ArkModsTab } from './server/ArkModsTab';
import { ArkSettingsTab } from './server/ArkSettingsTab';
import { ARK_MAPS, arkSettings } from '../games/ark';
import { SatisfactorySettingsTab } from './server/SatisfactorySettingsTab';
import { satisfactorySettings } from '../games/satisfactory';
import { zomboidSettings } from '../games/zomboid';
import { WorldTab } from './server/WorldTab';
import { AsaModsTab, HostedSettingsTab } from './server/HostedSettingsTab';
import { CustomModsSection } from './server/CustomModsSection';
import { isHosted } from '../games/hosted';
import { OverviewTab } from './server/OverviewTab';
import { GameTile } from '../games/GameTile';
import { useLanHost } from '../lib/lan';

type Group = 'overview' | 'console' | 'players' | 'mods' | 'backups' | 'settings';
const GROUPS: readonly Group[] = ['overview', 'console', 'players', 'mods', 'backups', 'settings'];
const GROUP_OF: Record<ServerTab, Group> = {
  overview: 'overview',
  console: 'console',
  players: 'players',
  mods: 'mods',
  store: 'mods',
  workshop: 'mods',
  ficsit: 'mods',
  backups: 'backups',
  config: 'settings',
  files: 'settings',
  world: 'settings',
};

export function ServerPage({ id, tab }: { id: string; tab: ServerTab }): ReactNode {
  const { t } = useI18n();
  const { nameOf } = useGames();
  const { state, statusFor, listError, refresh } = useLive();
  const { navigate } = useRouter();
  const server = state.servers?.find((entry) => entry.id === id);
  const actions = useServerActions(id);
  const host = useLanHost();

  useEffect(() => {
    document.title = t.server.documentTitle(server?.name ?? t.server.documentTitleFallback);
  }, [server?.name, t]);

  // with seven areas the tab row scrolls on a phone; the active one must not sit behind the edge
  useEffect(() => {
    document.querySelector(`nav[aria-label="${t.server.sectionsLabel}"] [aria-current="page"]`)?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
  }, [tab, server?.id, t]);

  if (state.servers === null) {
    return listError === null ? (
      <LoadingBlock label={t.server.loading} />
    ) : (
      <ErrorNotice error={new Error(listError)} title={t.server.loadFailed} action={<Button size="sm" onClick={() => void refresh()}>{t.common.retry}</Button>} />
    );
  }
  if (server === undefined) {
    return (
      <EmptyState icon={ServerOff} title={t.server.notFound.title} action={<Button onClick={() => navigate('/')}>{t.server.notFound.toOverview}</Button>}>
        <p>{t.server.notFound.body}</p>
      </EmptyState>
    );
  }

  const status = statusFor(server);
  const names = contentNames(server);
  const restartNeeded = state.restartNeeded[server.id] === true && (status.state === 'starting' || status.state === 'online');
  const installed = server.installState === 'installed';
  const minecraft = server.game === 'minecraft';
  // Six areas; an area that holds several parts gets a second row of links. The parts keep their own addresses.
  const PARTS: Record<string, readonly ServerTab[]> = {
    minecraft: ['overview', 'console', 'players', 'mods', 'store', 'backups', 'config', 'world'],
    zomboid: ['overview', 'console', 'players', 'workshop', 'backups', 'config', 'files'],
    satisfactory: ['overview', 'console', 'players', 'ficsit', 'backups', 'config', 'files'],
    ark: ['overview', 'console', 'players', 'workshop', 'backups', 'config', 'files'],
    asa: ['overview', 'console', 'players', 'workshop', 'backups', 'config', 'files'],
    valheim: ['overview', 'console', 'players', 'backups', 'config', 'files'],
    sevendays: ['overview', 'console', 'players', 'workshop', 'backups', 'config', 'files'],
    palworld: ['overview', 'console', 'players', 'workshop', 'backups', 'config', 'files'],
    terraria: ['overview', 'console', 'players', 'backups', 'config', 'files'],
  };
  const parts = PARTS[server.game] ?? PARTS.zomboid ?? [];
  const groupOf = (part: ServerTab): Group => GROUP_OF[part];
  const partLabel: Record<ServerTab, string> = {
    overview: t.server.tabs.overview,
    console: t.server.tabs.console,
    players: t.server.tabs.players,
    mods: names.plural,
    store: names.store,
    workshop: t.server.tabs.workshop,
    ficsit: t.server.tabs.ficsit,
    backups: t.server.tabs.backups,
    config: t.server.tabs.config,
    files: t.server.tabs.files,
    world: t.server.tabs.world,
  };
  const groups = GROUPS.map((group) => ({ id: group, label: t.server.groups[group], first: parts.find((part) => groupOf(part) === group) })).filter(
    (group): group is { id: Group; label: string; first: ServerTab } => group.first !== undefined,
  );
  const activeGroup = groupOf(tab);
  const subParts = parts.filter((part) => groupOf(part) === activeGroup);
  const modsTab = parts.find((part) => groupOf(part) === 'mods') ?? 'mods';
  const ark = arkSettings(server);
  const satisfactory = satisfactorySettings(server);
  const zomboid = zomboidSettings(server);
  const ports = zomboid !== null ? t.zomboid.header.ports(server.port, zomboid.udpPort) : satisfactory !== null ? t.satisfactory.header.ports(server.port, satisfactory.reliablePort) : ark !== null ? t.ark.header.ports(server.port, ark.queryPort) : t.server.header.port(server.port);
  // one line under the name: the game, the one setting that tells servers of a game apart, where to join, who plays
  const facts: ReactNode[] = [
    minecraft ? `${LOADER_LABEL[server.loader]}${server.loaderVersion === null ? '' : ` ${server.loaderVersion}`} · ${t.server.header.minecraft(server.mcVersion)}` : nameOf(server.game),
    ...(zomboid === null ? [] : [t.zomboid.header.branch(zomboid.branch)]),
    ...(satisfactory === null ? [] : [t.satisfactory.header.branch(satisfactory.branch)]),
    ...(ark === null ? [] : [t.ark.header.map(ARK_MAPS[ark.map] ?? ark.map)]),
    <span className="select-all text-ink" title={ports}>
      {t.server.join(`${host ?? 'localhost'}:${status.port ?? server.port}`)}
    </span>,
    <span className="inline-flex items-center gap-1.5">
      <Users aria-hidden className="size-4" />
      {status.players.length > 0 ? status.players.join(', ') : (status.playerCount ?? null) !== null ? t.gamePlayers.countOnly(status.playerCount ?? 0) : t.server.header.noPlayers}
    </span>,
  ];
  const waitingForJava = status.state === 'preparing' ? preparingMajor(status.message, status.messageRef) : null;

  return (
    <div className="space-y-4">
      <Link to="/" className="link-btn gap-1.5 text-dim no-underline hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" />
        {t.server.back}
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <GameTile game={server.game} size="lg" />
          <div className="min-w-56 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-2xl">{server.name}</h1>
              <StatusChip server={server} status={status} />
            </div>
            <p className="num flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-dim">
              {facts.map((fact, index) => (
                <span key={index} className="inline-flex items-center gap-2">
                  {index === 0 ? null : (
                    <span aria-hidden className="text-faint">
                      ·
                    </span>
                  )}
                  {fact}
                </span>
              ))}
            </p>
          </div>
          <ActionBar server={server} status={status} actions={actions} menu />
        </div>
        <ActionFeedback serverId={server.id} actions={actions} />
        {status.state === 'preparing' ? (
          <Notice tone="info" title={renderOptionalRef(status.messageRef, t, status.message) ?? t.server.preparing.fallbackTitle}>
            <p>{t.server.preparing.body}</p>
            {waitingForJava === null ? null : <JavaProgress major={waitingForJava} fallback={{ percent: null, message: null }} />}
          </Notice>
        ) : null}
        {restartNeeded ? (
          <Notice tone="warn" title={t.server.restartNeeded.title}>
            {t.server.restartNeeded.body}
            <span className="mt-2 block">
              <Button size="sm" icon={RotateCcw} loading={actions.busy === 'restart'} disabled={actions.busy !== null || status.state !== 'online'} onClick={() => void actions.run('restart')}>
                {t.server.restartNeeded.action}
              </Button>
            </span>
          </Notice>
        ) : null}
      </header>

      {installed ? null : (
        <section aria-label={t.server.installation} className="panel space-y-3 p-4">
          <h2 className="text-base">{t.server.installation}</h2>
          <InstallPanel server={server} />
        </section>
      )}

      <nav aria-label={t.server.sectionsLabel} className="-mx-4 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-1">
          {groups.map((group) => {
            const active = group.id === activeGroup;
            return (
              <li key={group.id}>
                <Link
                  to={serverPath(server.id, group.first)}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'flex min-h-11 items-center border-b-2 px-2.5 text-sm font-medium no-underline sm:px-3.5 sm:text-base',
                    active ? 'border-accent text-ink' : 'border-transparent text-dim hover:text-ink',
                  )}
                >
                  {group.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {subParts.length > 1 ? (
        <nav aria-label={t.server.partsLabel(t.server.groups[activeGroup])}>
          <ul className="flex flex-wrap gap-1.5">
            {subParts.map((part) => (
              <li key={part}>
                <Link
                  to={serverPath(server.id, part)}
                  aria-current={part === tab ? 'page' : undefined}
                  className={cx('chip min-h-9 px-3 text-sm no-underline', part === tab ? 'chip-accent' : 'text-dim hover:text-ink')}
                >
                  {partLabel[part]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <div role="region" aria-label={partLabel[tab]}>
        {tab === 'overview' ? <OverviewTab key={server.id} server={server} status={status} modsTab={modsTab} /> : null}
        {tab === 'console' ? <ConsoleTab key={server.id} server={server} status={status} /> : null}
        {tab !== 'config' ? null : minecraft ? (
          <ConfigTab key={server.id} server={server} status={status} />
        ) : server.game === 'satisfactory' ? (
          <SatisfactorySettingsTab key={server.id} server={server} status={status} />
        ) : server.game === 'ark' ? (
          <ArkSettingsTab key={server.id} server={server} status={status} />
        ) : isHosted(server.game) ? (
          <HostedSettingsTab key={server.id} server={server} status={status} game={server.game} />
        ) : (
          <ZomboidSettingsTab key={server.id} server={server} status={status} />
        )}
        {!minecraft ? null : tab === 'world' ? <WorldTab key={server.id} server={server} status={status} /> : null}
        {tab === 'players' && !minecraft ? <GamePlayersTab key={server.id} server={server} status={status} /> : null}
        {!minecraft ? null : tab === 'players' ? <PlayersTab key={server.id} server={server} status={status} /> : null}
        {!minecraft ? null : tab === 'mods' ? <ModsTab key={server.id} server={server} status={status} /> : null}
        {!minecraft ? null : tab === 'store' ? <StoreTab key={server.id} server={server} status={status} /> : null}
        {tab === 'files' && !minecraft ? <FilesTab key={server.id} server={server} status={status} /> : null}
        {tab === 'ficsit' && server.game === 'satisfactory' ? <FicsitTab key={server.id} server={server} status={status} /> : null}
        {tab === 'workshop' && server.game === 'ark' ? <ArkModsTab key={server.id} server={server} status={status} /> : null}
        {tab === 'workshop' && server.game === 'zomboid' ? <WorkshopTab key={server.id} server={server} status={status} /> : null}
        {tab === 'workshop' && server.game === 'asa' ? <AsaModsTab key={server.id} server={server} status={status} /> : null}
        {tab === 'workshop' && (server.game === 'sevendays' || server.game === 'palworld') ? <CustomModsSection key={server.id} server={server} status={status} /> : null}
        {tab === 'backups' ? <BackupsTab key={server.id} server={server} status={status} /> : null}
      </div>
      <GameDisclaimer game={server.game} />
    </div>
  );
}
