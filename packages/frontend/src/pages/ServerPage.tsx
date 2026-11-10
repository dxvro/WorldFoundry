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
import { formatDuration } from '../lib/format';
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
import { SatisfactorySettingsTab } from './server/SatisfactorySettingsTab';
import { satisfactorySettings } from '../games/satisfactory';
import { zomboidSettings } from '../games/zomboid';
import { WorldTab } from './server/WorldTab';

export function ServerPage({ id, tab }: { id: string; tab: ServerTab }): ReactNode {
  const { t } = useI18n();
  const { nameOf } = useGames();
  const { state, statusFor, listError, refresh } = useLive();
  const { navigate } = useRouter();
  const server = state.servers?.find((entry) => entry.id === id);
  const actions = useServerActions(id);

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
  const allTabs: Array<{ id: ServerTab; label: string }> = [
    { id: 'console', label: t.server.tabs.console },
    { id: 'config', label: t.server.tabs.config },
    { id: 'files', label: t.server.tabs.files },
    { id: 'workshop', label: t.server.tabs.workshop },
    { id: 'ficsit', label: t.server.tabs.ficsit },
    { id: 'world', label: t.server.tabs.world },
    { id: 'players', label: t.server.tabs.players },
    { id: 'mods', label: names.plural },
    { id: 'store', label: names.store },
    { id: 'backups', label: t.server.tabs.backups },
  ];
  const minecraft = server.game === 'minecraft';
  const ZOMBOID_TABS: readonly ServerTab[] = ['console', 'config', 'files', 'players', 'workshop', 'backups'];
  const MINECRAFT_TABS: readonly ServerTab[] = ['console', 'config', 'world', 'players', 'mods', 'store', 'backups'];
  const SATISFACTORY_TABS: readonly ServerTab[] = ['console', 'config', 'files', 'players', 'ficsit', 'backups'];
  const shown = minecraft ? MINECRAFT_TABS : server.game === 'satisfactory' ? SATISFACTORY_TABS : ZOMBOID_TABS;
  const tabs = allTabs.filter((entry) => shown.includes(entry.id));
  const satisfactory = satisfactorySettings(server);
  const zomboid = zomboidSettings(server);
  const waitingForJava = status.state === 'preparing' ? preparingMajor(status.message, status.messageRef) : null;

  return (
    <div className="space-y-4">
      <Link to="/" className="link-btn gap-1.5 text-dim no-underline hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" />
        {t.server.back}
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-2xl">{server.name}</h1>
          <StatusChip server={server} status={status} />
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-dim">
          {minecraft ? (
            <>
              <span className="chip">{LOADER_LABEL[server.loader]}{server.loaderVersion === null ? '' : ` ${server.loaderVersion}`}</span>
              <span className="num">{t.server.header.minecraft(server.mcVersion)}</span>
              <span className="num">{t.server.header.port(status.port ?? server.port)}</span>
            </>
          ) : (
            <>
              <span className="chip">{nameOf(server.game)}</span>
              {zomboid === null ? null : <span className="num">{t.zomboid.header.branch(zomboid.branch)}</span>}
              {satisfactory === null ? null : <span className="num">{t.satisfactory.header.branch(satisfactory.branch)}</span>}
              <span className="num">
                {zomboid !== null ? t.zomboid.header.ports(server.port, zomboid.udpPort) : satisfactory !== null ? t.satisfactory.header.ports(server.port, satisfactory.reliablePort) : t.server.header.port(server.port)}
              </span>
            </>
          )}
          {status.startedAt !== null && (status.state === 'online' || status.state === 'starting') ? <span className="num">{t.server.header.runningSince(formatDuration(Date.now() - status.startedAt))}</span> : null}
          <span className="num inline-flex items-center gap-1.5">
            <Users aria-hidden className="size-4" />
            {status.players.length > 0 ? status.players.join(', ') : (status.playerCount ?? null) !== null ? t.gamePlayers.countOnly(status.playerCount ?? 0) : t.server.header.noPlayers}
          </span>
        </p>
        <ActionBar server={server} status={status} actions={actions} />
        <ActionFeedback serverId={server.id} actions={actions} />
        <GameDisclaimer game={server.game} />
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
          {tabs.map((entry) => {
            const active = entry.id === tab;
            return (
              <li key={entry.id}>
                <Link
                  to={serverPath(server.id, entry.id)}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'flex min-h-11 items-center border-b-2 px-2.5 text-sm font-medium no-underline sm:px-3.5 sm:text-base',
                    active ? 'border-accent text-ink' : 'border-transparent text-dim hover:text-ink',
                  )}
                >
                  {entry.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div role="region" aria-label={tabs.find((entry) => entry.id === tab)?.label}>
        {tab === 'console' ? <ConsoleTab key={server.id} server={server} status={status} /> : null}
        {tab !== 'config' ? null : minecraft ? (
          <ConfigTab key={server.id} server={server} status={status} />
        ) : server.game === 'satisfactory' ? (
          <SatisfactorySettingsTab key={server.id} server={server} />
        ) : (
          <ZomboidSettingsTab key={server.id} server={server} />
        )}
        {!minecraft ? null : tab === 'world' ? <WorldTab key={server.id} server={server} status={status} /> : null}
        {tab === 'players' && !minecraft ? <GamePlayersTab key={server.id} server={server} status={status} /> : null}
        {!minecraft ? null : tab === 'players' ? <PlayersTab key={server.id} server={server} status={status} /> : null}
        {!minecraft ? null : tab === 'mods' ? <ModsTab key={server.id} server={server} status={status} /> : null}
        {!minecraft ? null : tab === 'store' ? <StoreTab key={server.id} server={server} status={status} /> : null}
        {tab === 'files' && !minecraft ? <FilesTab key={server.id} server={server} status={status} /> : null}
        {tab === 'ficsit' && server.game === 'satisfactory' ? <FicsitTab key={server.id} server={server} status={status} /> : null}
        {tab === 'workshop' && server.game === 'zomboid' ? <WorkshopTab key={server.id} server={server} status={status} /> : null}
        {tab === 'backups' ? <BackupsTab key={server.id} server={server} status={status} /> : null}
      </div>
    </div>
  );
}
