export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

// How far from the bottom (in px) still counts as "reading the newest line".
export const FOLLOW_THRESHOLD_PX = 24;

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
}

export function isNearBottom(metrics: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(metrics) <= threshold;
}

// The view follows new output while the user sits at the bottom and stops as soon as they scroll up.
// Growing content alone never changes this decision; only a scroll event does.
export function followAfterScroll(metrics: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return isNearBottom(metrics, threshold);
}

// Lines that arrived while the view was not following, for the "jump to newest" button.
export function unseenCount(following: boolean, previousUnseen: number, added: number): number {
  return following ? 0 : previousUnseen + added;
}
