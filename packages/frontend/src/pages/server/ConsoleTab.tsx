import { ArrowDownToLine, Send, Skull } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Notice, cx } from '../../components/ui';
import { CommandHistory, loadHistory, saveHistory } from '../../console/history';
import { MAX_CONSOLE_LINES, filterRows, type ConsoleRow } from '../../console/model';
import { followAfterScroll, unseenCount } from '../../console/scroll';
import { CommandError } from '../../console/session';
import { useConsole } from '../../console/useConsole';
import { errorMessage, renderOptionalRef, renderRef, useI18n } from '../../i18n';
import { formatClock } from '../../lib/format';
import type { ConsoleStream, RuntimeStatus, ServerView } from '../../lib/types';
import { useLive } from '../../live/LiveProvider';

const STREAMS: ConsoleStream[] = ['stdout', 'stderr', 'input', 'system'];
const STREAM_MARK: Record<ConsoleStream | 'gap', string> = { stdout: ' ', stderr: '!', input: '›', system: '·', gap: '…' };
const STREAM_TEXT: Record<ConsoleStream | 'gap', string> = {
  stdout: 'text-dim',
  stderr: 'text-warn',
  input: 'text-accent',
  system: 'text-faint italic',
  gap: 'text-faint italic',
};

function Highlighted({ text, needle }: { text: string; needle: string }): ReactNode {
  if (needle === '') return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at} className="rounded-sm bg-accent/30 text-ink">{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return parts;
}

const Row = memo(function Row({ row, needle }: { row: ConsoleRow; needle: string }): ReactNode {
  const { t } = useI18n();
  return (
    <div className={cx('flex gap-2 px-3', STREAM_TEXT[row.stream])} data-stream={row.stream}>
      <span aria-hidden className="num hidden w-16 shrink-0 text-faint sm:inline">
        {formatClock(row.time)}
      </span>
      <span aria-hidden className="w-3 shrink-0 text-center">
        {STREAM_MARK[row.stream]}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        <span className="sr-only">{row.stream === 'gap' ? '' : `${t.console.stream[row.stream]}: `}</span>
        <Highlighted text={renderRef(row.textRef, t, row.text)} needle={needle} />
      </span>
    </div>
  );
});

function CrashPanel({ status, lastLines }: { status: RuntimeStatus; lastLines: string[] }): ReactNode {
  const { t } = useI18n();
  return (
    <section aria-label={t.console.crash.label} className="space-y-2 rounded-lg border border-bad/50 bg-bad/10 p-3">
      <h3 className="flex items-center gap-2 text-base text-bad">
        <Skull aria-hidden className="size-4" />
        {status.exitCode === null ? t.console.crash.notStarted : t.console.crash.crashed}
      </h3>
      <p className="num text-dim">
        {status.exitCode === null ? t.console.crash.noExitCode : t.console.crash.exitCode(status.exitCode)} {renderOptionalRef(status.messageRef, t, status.message) ?? ''}
      </p>
      {lastLines.length === 0 ? null : (
        <>
          <p className="label">{t.console.crash.lastLines}</p>
          <pre tabIndex={0} aria-label={t.console.crash.lastLinesLabel} className="console-body max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-canvas p-2 text-dim">
            {lastLines.join('\n')}
          </pre>
        </>
      )}
    </section>
  );
}

export function ConsoleTab({ server, status }: { server: ServerView; status: RuntimeStatus }): ReactNode {
  const { t } = useI18n();
  const { state } = useLive();
  const consoleState = useConsole(server.id);
  const { model, connection, send } = consoleState;
  const [filterText, setFilterText] = useState('');
  const [streams, setStreams] = useState<ReadonlySet<ConsoleStream>>(() => new Set(STREAMS));
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [command, setCommand] = useState('');
  const [sendError, setSendError] = useState<CommandError | null>(null);
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const previousSeq = useRef(0);
  const history = useRef<CommandHistory>(new CommandHistory());

  useEffect(() => {
    history.current = new CommandHistory(loadHistory(server.id));
  }, [server.id]);

  const needle = filterText.trim().toLowerCase();
  const rows = useMemo(() => filterRows(model.rows, { text: filterText, streams }, (row) => renderRef(row.textRef, t, row.text)), [model.rows, filterText, streams, t]);

  useLayoutEffect(() => {
    const element = scroller.current;
    const added = model.lastSeq - previousSeq.current;
    previousSeq.current = model.lastSeq;
    if (element === null) return;
    if (following) element.scrollTop = element.scrollHeight;
    setUnseen((value) => unseenCount(following, value, Math.max(0, added)));
  }, [rows, model.lastSeq, following]);

  const onScroll = (): void => {
    const element = scroller.current;
    if (element !== null) setFollowing(followAfterScroll(element));
  };

  const jumpToNewest = (): void => {
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
    setFollowing(true);
    setUnseen(0);
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const text = command.trim();
    if (text === '' || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await send(text);
      history.current.push(text);
      saveHistory(server.id, history.current.items);
      setCommand('');
      jumpToNewest();
    } catch (cause) {
      setSendError(cause instanceof CommandError ? cause : new CommandError('UNKNOWN', t.console.command.sendFailed));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowUp') {
      const previous = history.current.previous(command);
      if (previous !== null) {
        event.preventDefault();
        setCommand(previous);
      }
    } else if (event.key === 'ArrowDown') {
      const next = history.current.next();
      if (next !== null) {
        event.preventDefault();
        setCommand(next);
      }
    }
  };

  const toggleStream = (stream: ConsoleStream): void =>
    setStreams((current) => {
      const next = new Set(current);
      if (next.has(stream)) next.delete(stream);
      else next.add(stream);
      return next;
    });

  const crash = state.crashes[server.id];
  const crashLines = crash?.lastLines.map((line, index) => renderRef(crash.lastLinesRefs?.[index], t, line)) ?? model.rows.filter((row) => row.stream !== 'gap').slice(-15).map((row) => renderRef(row.textRef, t, row.text));
  const live = status.state;
  const connectionText = connection === 'open' ? null : connection === 'connecting' ? t.console.connection.connecting : t.console.connection.reconnecting;

  return (
    <div className="space-y-3">
      {status.state === 'crashed' ? <CrashPanel status={status} lastLines={crashLines} /> : null}
      {connectionText === null ? null : <Notice tone="warn">{connectionText}</Notice>}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label={t.console.filter.label}
          placeholder={t.console.filter.placeholder}
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          className="input min-w-0 flex-1 basis-48 sm:max-w-xs"
        />
        <div role="group" aria-label={t.console.filter.streamsLabel} className="flex flex-wrap gap-1.5">
          {STREAMS.map((stream) => (
            <button
              key={stream}
              type="button"
              aria-pressed={streams.has(stream)}
              onClick={() => toggleStream(stream)}
              className={cx('btn btn-sm', streams.has(stream) ? 'border-accent/60 text-accent' : 'text-faint')}
            >
              {t.console.stream[stream]}
            </button>
          ))}
        </div>
        <p className="num hint ml-auto">
          {rows.length === model.rows.length ? t.console.filter.lines(model.rows.length) : t.console.filter.linesOf(rows.length, model.rows.length)}
          {model.rows.length >= MAX_CONSOLE_LINES ? t.console.filter.max : ''}
        </p>
      </div>

      <div className="relative">
        <div
          ref={scroller}
          onScroll={onScroll}
          role="log"
          aria-label={t.console.log.label(server.name)}
          tabIndex={0}
          className="console-body h-[55dvh] min-h-72 overflow-y-auto rounded-lg border border-line bg-canvas py-2"
        >
          {model.rows.length === 0 ? (
            <p className="px-3 text-faint">{connection === 'open' ? t.console.log.empty : t.console.log.waiting}</p>
          ) : rows.length === 0 ? (
            <p className="px-3 text-faint">{t.console.log.noMatch}</p>
          ) : (
            rows.map((row) => <Row key={row.seq} row={row} needle={needle} />)
          )}
        </div>
        {following ? null : (
          <Button size="sm" variant="primary" icon={ArrowDownToLine} onClick={jumpToNewest} className="absolute right-4 bottom-4 shadow-lg shadow-black/50">
            {unseen > 0 ? t.console.log.newLines(unseen) : t.console.log.jumpToNewest}
          </Button>
        )}
      </div>

      <form onSubmit={(event) => void submit(event)} className="space-y-2">
        <div className="flex gap-2">
          <input
            aria-label={t.console.command.label}
            aria-describedby={sendError === null ? undefined : 'console-send-error'}
            aria-invalid={sendError === null ? undefined : true}
            className="input console-body min-w-0 flex-1"
            placeholder={live === 'online' || live === 'starting' ? t.console.command.placeholderOnline : t.console.command.placeholderOffline}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={command}
            maxLength={1024}
            onChange={(event) => {
              setCommand(event.target.value);
              history.current.resetCursor();
              if (sendError !== null) setSendError(null);
            }}
            onKeyDown={onKeyDown}
          />
          <Button type="submit" variant="primary" icon={Send} loading={sending} disabled={command.trim() === ''}>
            {t.console.command.send}
          </Button>
        </div>
        {sendError === null ? null : (
          <p id="console-send-error" role="alert" className="text-sm text-bad">
            {errorMessage(sendError, t)}
          </p>
        )}
        <p className="hint">{t.console.command.historyHint}</p>
      </form>
    </div>
  );
}
