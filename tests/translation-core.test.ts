import { beforeEach, describe, expect, it } from 'vitest';
import { findTranslationCandidates, isMeaningfulText, isIdentifierLikeText } from '../chrome-plugin/src/translation-core';

describe('translation core', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds readable block text and skips protected content', () => {
    document.body.innerHTML = `
      <main>
        <article><p>This is a readable paragraph for translation.</p></article>
        <script><p>Do not translate this.</p></script>
        <pre>const value = 1;</pre>
        <p translate="no">Keep this original.</p>
        <p>https://example.com</p>
      </main>
    `;

    const candidates = findTranslationCandidates(document.body);
    expect(candidates.map((candidate) => candidate.text)).toContain('This is a readable paragraph for translation.');
    expect(candidates.some((candidate) => candidate.text.includes('Do not translate'))).toBe(false);
    expect(candidates.some((candidate) => candidate.text.includes('const value'))).toBe(false);
    expect(candidates.some((candidate) => candidate.text.includes('Keep this original'))).toBe(false);
  });

  it('rejects identifiers and accepts meaningful prose', () => {
    expect(isIdentifierLikeText('https://example.com')).toBe(true);
    expect(isIdentifierLikeText('main.ts')).toBe(true);
    expect(isMeaningfulText('')).toBe(false);
    expect(isMeaningfulText('A useful sentence')).toBe(true);
  });

  it('does not include parent block when child blocks are already candidates', () => {
    document.body.innerHTML = `
      <div class="card">
        <h3>Featured Story Title Here</h3>
        <p>Read the latest news about technology and science discoveries today.</p>
        <p>Our dedicated team covers emerging trends every single week.</p>
      </div>
    `;

    const candidates = findTranslationCandidates(document.body);
    const texts = candidates.map((candidate) => candidate.text);

    expect(texts).toContain('Featured Story Title Here');
    expect(texts.some((t) => t.includes('Read the latest news'))).toBe(true);
    expect(texts.some((t) => t.includes('Our dedicated team'))).toBe(true);

    const parentText = 'Featured Story Title Here Read the latest news about technology and science discoveries today. Our dedicated team covers emerging trends every single week.';
    expect(texts.some((t) => t.length >= parentText.length * 0.9)).toBe(false);
  });

  it('excludes grandparent and parent when leaf elements are candidates', () => {
    document.body.innerHTML = `
      <section class="article">
        <div class="content">
          <p>First paragraph of the article with enough meaningful text to be translated properly.</p>
          <p>Second paragraph discussing important details that are worth reading and understanding.</p>
          <p>Third paragraph wraps up the main points and conclusions of this article section.</p>
        </div>
      </section>
    `;

    const candidates = findTranslationCandidates(document.body);
    const elements = candidates.map((candidate) => candidate.element.tagName);
    const texts = candidates.map((candidate) => candidate.text);

    expect(elements).toEqual(expect.arrayContaining(['P', 'P', 'P']));
    expect(candidates.length).toBe(3);
    expect(texts.every((t) => !(t.includes('First paragraph') && t.includes('Third paragraph')))).toBe(true);
  });

  it('deduplicates candidates that contain each other at multiple nesting levels', () => {
    document.body.innerHTML = `
      <section class="outer">
        <div class="inner">
          <p>First paragraph with enough content to be meaningful for translation purposes.</p>
          <p>Second paragraph discussing the main topic in detail for the readers.</p>
        </div>
        <p>Third paragraph at section level outside the inner div element.</p>
      </section>
    `;

    const candidates = findTranslationCandidates(document.body);
    const elements = candidates.map((candidate) => candidate.element.className);
    const tags = candidates.map((candidate) => candidate.element.tagName);

    expect(tags).toEqual(['P', 'P', 'P']);
    expect(candidates.length).toBe(3);
    expect(elements).not.toContain('outer');
    expect(elements).not.toContain('inner');
  });

  it('captures typography snapshot for every candidate', () => {
    document.body.innerHTML = '<p style="font-size: 18px; line-height: 1.6;">Meaningful prose that should be translated.</p>';
    const candidates = findTranslationCandidates(document.body);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].typography).toHaveProperty('fontSizePx');
    expect(candidates[0].typography).toHaveProperty('lineHeightRatio');
  });

  it('excludes interactive controls and table structure rows from candidates', () => {
    document.body.innerHTML = `
      <button>Click me to perform an action</button>
      <input value="type here" />
      <table>
        <tbody>
          <tr>
            <td>Cell with meaningful text worth translating.</td>
          </tr>
        </tbody>
      </table>
    `;
    const candidates = findTranslationCandidates(document.body);
    const tags = candidates.map((candidate) => candidate.element.tagName);
    expect(tags).not.toContain('BUTTON');
    expect(tags).not.toContain('INPUT');
    expect(tags).not.toContain('TABLE');
    expect(tags).not.toContain('TBODY');
    expect(tags).not.toContain('TR');
    expect(tags).toContain('TD');
  });
});
