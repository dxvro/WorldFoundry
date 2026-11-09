import { describe, expect, it } from 'vitest';
import { FOLLOW_THRESHOLD_PX, followAfterScroll, isNearBottom, unseenCount } from './scroll';

const view = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) => ({ scrollTop, scrollHeight, clientHeight });

describe('autoscroll', () => {
  it('follows when the view sits at the bottom', () => {
    expect(isNearBottom(view(600))).toBe(true);
    expect(isNearBottom(view(600 - FOLLOW_THRESHOLD_PX))).toBe(true);
  });

  it('pauses as soon as the user scrolls up past the threshold', () => {
    expect(followAfterScroll(view(600 - FOLLOW_THRESHOLD_PX - 1))).toBe(false);
    expect(followAfterScroll(view(100))).toBe(false);
  });

  it('resumes when the user scrolls back down', () => {
    expect(followAfterScroll(view(100))).toBe(false);
    expect(followAfterScroll(view(590))).toBe(true);
  });

  it('treats a view that does not scroll at all as following', () => {
    expect(followAfterScroll({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });

  it('counts unseen lines only while paused and resets when following', () => {
    expect(unseenCount(false, 0, 5)).toBe(5);
    expect(unseenCount(false, 5, 3)).toBe(8);
    expect(unseenCount(true, 8, 3)).toBe(0);
  });
});
