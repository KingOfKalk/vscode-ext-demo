import { describe, expect, it } from 'vitest';
import { renderWindowHtml } from '../../src/windowHtml';

const options = {
  nonce: 'abc123',
  cspSource: 'https://webview.example',
  scriptUri: 'https://webview.example/dist/webview.js',
  styleUri: 'https://webview.example/media/window.css',
};

function csp(html: string): string {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

describe('renderWindowHtml', () => {
  const html = renderWindowHtml(options);

  it('sets exactly the strict content security policy', () => {
    expect(csp(html)).toBe(
      "default-src 'none'; script-src 'nonce-abc123'; style-src https://webview.example",
    );
  });

  it('loads the script with the nonce and the stylesheet from the given URIs', () => {
    expect(html).toContain(
      '<script nonce="abc123" src="https://webview.example/dist/webview.js"></script>',
    );
    expect(html).toContain(
      '<link rel="stylesheet" href="https://webview.example/media/window.css">',
    );
  });

  it('has no inline script, inline style or inline event handler', () => {
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('is an English document', () => {
    expect(html).toMatch(/^<!DOCTYPE html>\n<html lang="en">/);
  });

  it('has the five element IDs', () => {
    for (const id of ['message', 'count', 'increment', 'decrement', 'reset']) {
      expect(html.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1);
    }
  });

  it('has real buttons with their texts', () => {
    expect(html).toContain('<button type="button" id="increment">Click me</button>');
    expect(html).toContain('<button type="button" id="decrement">Decrement</button>');
    expect(html).toContain('<button type="button" id="reset">Reset</button>');
  });

  it('shows the label before the count and announces both politely', () => {
    expect(html).toContain('<p aria-live="polite">Clicked: <span id="count"></span></p>');
    expect(html).toContain('<p id="message" aria-live="polite"></p>');
  });

  it('contains no message text; it arrives as a state message', () => {
    expect(html).not.toContain('Hello from kingofkalk!');
    expect(html).toMatch(/<p id="message"[^>]*><\/p>/);
  });

  it('escapes every interpolated value', () => {
    const hostile = renderWindowHtml({
      nonce: '"><script>alert(1)</script>',
      cspSource: `x'"><img src=x onerror=alert(1)>`,
      scriptUri: '"><script>alert(2)</script>',
      styleUri: `" onload="alert(3)`,
    });
    expect(hostile).not.toContain('<script>alert');
    expect(hostile).not.toContain('<img');
    expect(hostile).not.toContain('" onload="');
    expect(hostile).toContain('nonce="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(hostile).toContain('x&#39;&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes ampersands', () => {
    const escaped = renderWindowHtml({ ...options, styleUri: 'https://x.example/a?b=1&c=2' });
    expect(escaped).toContain('href="https://x.example/a?b=1&amp;c=2"');
  });
});
