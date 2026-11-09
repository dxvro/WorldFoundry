import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// jsdom has no <dialog> behaviour
if (typeof HTMLDialogElement !== 'undefined' && typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}

window.scrollTo = (): void => undefined;

// findBy*/waitFor wait up to 1 s by default; the first screen of a file is slow to render on a busy machine
configure({ asyncUtilTimeout: 5000 });
