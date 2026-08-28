import { describe, expect, it } from 'vitest';
import { beginTranslation, getTranslationState } from '../chrome-plugin/src/entrypoints/content/translationState';
import { captureElementTypography } from '../chrome-plugin/src/translation-core/typography';

describe('translation state', () => {
  it('increments generation for a new attempt on the same element', () => {
    const element = document.createElement('p');
    const typography = captureElementTypography(element);
    const first = beginTranslation(element, 'Hello', typography);
    const second = beginTranslation(element, 'Hello again', typography);

    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(getTranslationState(element)?.sourceText).toBe('Hello again');
  });
});
