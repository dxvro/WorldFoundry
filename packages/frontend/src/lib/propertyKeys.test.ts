import { describe, expect, it } from 'vitest';
// the catalog of the backend as text, so the test needs no code of the backend
import catalogSource from '../../../backend/src/properties/catalog.ts?raw';
import { en } from '../i18n';
import { KNOWN_PROPERTY_KEYS, isKnownPropertyKey } from './propertyKeys';

describe('known property keys', () => {
  it('list exactly the keys of the backend catalog', () => {
    const backendKeys = [...catalogSource.matchAll(/\b(?:flag|int|text|choice|port)\(\s*'([^']+)'/g)].map((match) => match[1] as string);
    expect(backendKeys.length).toBeGreaterThan(40);
    expect([...KNOWN_PROPERTY_KEYS].sort()).toEqual([...backendKeys].sort());
  });

  it('have a label and a description in both languages', () => {
    for (const dictionary of [en]) {
      for (const key of KNOWN_PROPERTY_KEYS) {
        const text = dictionary.world.props[key];
        expect(text.label, key).not.toBe('');
        expect(text.help, key).not.toBe('');
      }
    }
  });

  it('recognises catalog keys only', () => {
    expect(isKnownPropertyKey('view-distance')).toBe(true);
    expect(isKnownPropertyKey('my-mod.option')).toBe(false);
    expect(isKnownPropertyKey('toString')).toBe(false);
  });
});
