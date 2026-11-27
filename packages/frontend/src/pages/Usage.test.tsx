import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { FakeSocket } from '../test/fakes';
import { baseRoutes, mockApi, serverFixture } from '../test/mockApi';

const GB = 1024 ** 3;
const at = (i: number): number => Date.UTC(2026, 10, 27, 10, 0, i * 5);
const usage = {
  intervalMs: 5000,
  host: { cpuCount: 8, cpuModel: 'Test CPU 9000', loadAverage: [1.5, 1.2, 0.9], uptimeSeconds: 90_000, totalMemoryBytes: 16 * GB, disk: { totalBytes: 100 * GB, freeBytes: 10 * GB }, appMemoryBytes: 0.1 * GB },
  samples: [0, 1, 2].map((i) => ({ at: at(i), cpuPercent: i === 0 ? null : 20 + i, memoryUsedBytes: 8 * GB })),
  servers: [{ serverId: 'srv-1', samples: [0, 1, 2].map((i) => ({ at: at(i), cpuPercent: 10, rssBytes: 1.9 * GB })) }],
};
const running = { state: 'online', pid: 4, startedAt: at(0), exitCode: null, message: null, messageRef: null, players: [], port: 25565, cpuPercent: 10, rssBytes: 1.9 * GB };

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  window.history.replaceState(null, '', '/usage');
});
afterEach(() => vi.unstubAllGlobals());

describe('usage page', () => {
  it('shows the machine, the share of the game servers and every server with its history', async () => {
    mockApi({
      ...baseRoutes(serverFixture({ name: 'Survival', maxRamMb: 2048, status: running })),
      'GET /api/system/usage': () => ({ body: usage }),
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Hardware usage' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: /main/i });
    expect(within(nav).getByRole('link', { name: 'Usage' })).toHaveAttribute('aria-current', 'page');

    const cpu = screen.getByRole('region', { name: 'CPU' });
    expect(within(cpu).getByText('22 %')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Memory' })).getByText('8 GB of 16 GB in use')).toBeInTheDocument();
    // 90 % of the disk is full
    const disk = screen.getByRole('region', { name: 'Disk (data folder)' });
    expect(within(disk).getByText('High')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'System' })).getByText('1.5 / 1.2 / 0.9')).toBeInTheDocument();

    expect(screen.getByRole('img', { name: /Game servers: 1.9 GB, Everything else: 6.1 GB, Free: 8 GB/ })).toBeInTheDocument();
    const servers = screen.getByRole('list', { name: 'Servers' });
    expect(within(servers).getByRole('link', { name: 'Survival' })).toBeInTheDocument();
    // 1.9 of 2 GB: close to the limit
    expect(within(servers).getByText('High')).toBeInTheDocument();
    const chart = within(servers).getByRole('img', { name: /Memory of Survival, last minutes: 1.9 GB/ });

    // hovering shows the value and the time of the reading
    const box = chart.parentElement as HTMLElement;
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 200, top: 0, height: 64, right: 200, bottom: 64, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(box, { clientX: 0 });
    expect(within(box).getByRole('status')).toHaveTextContent('1.9 GB');
  });
});
