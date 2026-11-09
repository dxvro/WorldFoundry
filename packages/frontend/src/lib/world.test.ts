import { describe, expect, it } from 'vitest';
import { parseRoute } from './router';
import { allAcknowledged, buildSelection, hasBlocker, initialChoices, needsAck, type ImportNoticeView, type ModMatchView } from './world';

const match = (key: string, state: ModMatchView['state'], extra: Partial<ModMatchView> = {}): ModMatchView => ({
  key,
  state,
  projectId: null,
  projectTitle: null,
  versionId: null,
  versionNumber: null,
  candidates: [],
  selected: state === 'jar' || state === 'jar-known' || state === 'found',
  ...extra,
});

describe('world import helpers', () => {
  it('turns matches and choices into jars to place and projects to install', () => {
    const matches = [
      match('jar:mods/a.jar', 'jar-known'),
      match('jar:mods/b.jar', 'jar'),
      match('fml:jei', 'found', { projectId: 'jei', versionId: 'v1' }),
      match('fml:x', 'ambiguous', { candidates: [{ projectId: 'p1', slug: 'x', title: 'X' }] }),
      match('fml:y', 'not-found'),
      match('jar:mods/c.jar', 'client-only'),
    ];
    const choices = initialChoices(matches);
    choices['jar:mods/b.jar'] = { selected: false, candidate: null };
    choices['fml:x'] = { selected: true, candidate: 'p1' };
    expect(buildSelection(matches, choices)).toEqual({
      jars: ['jar:mods/a.jar'],
      install: [
        { key: 'fml:jei', projectId: 'jei', versionId: 'v1' },
        { key: 'fml:x', projectId: 'p1' },
      ],
    });
  });

  it('only lets the import start when every warning is acknowledged and nothing blocks', () => {
    const notices: ImportNoticeView[] = [
      { code: 'A', level: 'info', text: 'a', needsConfirm: false },
      { code: 'B', level: 'warn', text: 'b', needsConfirm: true },
    ];
    expect(needsAck(notices).map((notice) => notice.code)).toEqual(['B']);
    expect(allAcknowledged(notices, [])).toBe(false);
    expect(allAcknowledged(notices, ['B'])).toBe(true);
    expect(hasBlocker(notices)).toBe(false);
    expect(hasBlocker([...notices, { code: 'C', level: 'error', text: 'c', needsConfirm: false }])).toBe(true);
  });

  it('routes the import wizard', () => {
    expect(parseRoute('/new/world')).toEqual({ name: 'new-world' });
    expect(parseRoute('/new/other').name).toBe('not-found');
  });
});
