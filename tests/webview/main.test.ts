import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { renderWindowHtml } from '../../src/windowHtml';
import { initWindow } from '../../src/webview/main';

function setup(html?: string) {
  const dom = new JSDOM(
    html ??
      renderWindowHtml({
        nonce: 'n',
        cspSource: 'https://webview.example',
        scriptUri: 'https://webview.example/dist/webview.js',
        styleUri: 'https://webview.example/media/window.css',
      }),
  );
  const { document } = dom.window;
  const postMessage = vi.fn<(message: unknown) => void>();
  initWindow(document, { postMessage });
  const send = (data: unknown): void => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  };
  const text = (id: string): string | null => document.getElementById(id)?.textContent ?? null;
  const click = (id: string): void => {
    document.getElementById(id)?.click();
  };
  return { dom, document, postMessage, send, text, click };
}

describe('initWindow', () => {
  it('posts ready once on load and nothing else', () => {
    const { postMessage } = setup();
    expect(postMessage.mock.calls).toEqual([[{ type: 'ready' }]]);
  });

  it('posts increment, decrement and reset on click', () => {
    const { postMessage, click } = setup();
    postMessage.mockClear();
    click('increment');
    click('decrement');
    click('reset');
    click('increment');
    expect(postMessage.mock.calls).toEqual([
      [{ type: 'increment' }],
      [{ type: 'decrement' }],
      [{ type: 'reset' }],
      [{ type: 'increment' }],
    ]);
  });

  it('shows count and message from a state message', () => {
    const { send, text } = setup();
    send({ type: 'state', count: 3, message: 'Hello from kingofkalk!' });
    expect(text('count')).toBe('3');
    expect(text('message')).toBe('Hello from kingofkalk!');
  });

  it('touches the message only when it changed, so a screen reader does not read it again', () => {
    const { dom, document, send, text } = setup();
    const message = document.getElementById('message');
    if (!message) throw new Error('no message element');
    const observer = new dom.window.MutationObserver(() => undefined);
    observer.observe(message, { childList: true, characterData: true, subtree: true });

    send({ type: 'state', count: 1, message: 'Hello' });
    expect(observer.takeRecords().length).toBeGreaterThan(0);

    send({ type: 'state', count: 2, message: 'Hello' });
    expect(observer.takeRecords()).toHaveLength(0);
    expect(text('count')).toBe('2');

    send({ type: 'state', count: 2, message: 'Hi' });
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    expect(text('message')).toBe('Hi');
    observer.disconnect();
  });

  it('does not count on click; it shows what state says', () => {
    const { send, text, click } = setup();
    send({ type: 'state', count: 3, message: 'm' });
    click('increment');
    click('decrement');
    expect(text('count')).toBe('3');
    send({ type: 'state', count: 4, message: 'm' });
    expect(text('count')).toBe('4');
  });

  it('shows markup in the message as text, without creating elements', () => {
    const { send, text, document } = setup();
    const hostile = '<img src=x onerror=alert(1)>';
    send({ type: 'state', count: 1, message: hostile });
    expect(text('message')).toBe(hostile);
    expect(document.querySelector('img')).toBeNull();
    expect(document.getElementById('message')?.children).toHaveLength(0);
  });

  it.each([
    ['null', null],
    ['a string', 'state'],
    ['an unknown type', { type: 'nope', count: 9, message: 'x' }],
    ['a string count', { type: 'state', count: '9', message: 'x' }],
    ['a negative count', { type: 'state', count: -9, message: 'x' }],
    ['a missing message', { type: 'state', count: 9 }],
  ])('ignores a malformed message: %s', (_name, data) => {
    const { send, text } = setup();
    send({ type: 'state', count: 2, message: 'kept' });
    send(data);
    expect(text('count')).toBe('2');
    expect(text('message')).toBe('kept');
  });

  it('throws when an expected element is missing', () => {
    const dom = new JSDOM('<!DOCTYPE html><body></body>');
    expect(() => initWindow(dom.window.document, { postMessage: vi.fn() })).toThrow(
      /#message is missing/,
    );
  });
});
