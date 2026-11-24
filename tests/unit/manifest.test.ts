import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS, CONFIG_SECTION, EXTENSION_ID, VIEW_ID, VIEW_TYPE } from '../../src/ids';

interface Command {
  command: string;
  title: string;
  category?: string;
  icon?: string;
}

interface Menu {
  command: string;
  when?: string;
  group?: string;
}

interface Property {
  type: string;
  default: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  description: string;
}

interface Manifest {
  name: string;
  publisher: string;
  private: boolean;
  license: string;
  engines: { vscode: string; node: string };
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  files: string[];
  activationEvents: string[];
  contributes: {
    commands: Command[];
    menus: { commandPalette: Menu[]; 'view/title': Menu[] };
    configuration: { title: string; properties: Record<string, Property> };
    viewsContainers: { activitybar: { id: string; title: string; icon: string }[] };
    views: Record<string, { id: string; name: string }[]>;
  };
}

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as Manifest;

describe('package.json manifest', () => {
  it('has the extension ID kingofkalk.vscode-ext-demo', () => {
    expect(`${pkg.publisher}.${pkg.name}`).toBe('kingofkalk.vscode-ext-demo');
    expect(EXTENSION_ID).toBe('kingofkalk.vscode-ext-demo');
  });

  it('is private and MIT licensed', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe('MIT');
  });

  it('pins engines.vscode to @types/vscode', () => {
    expect(pkg.engines.vscode).toBe(`^${pkg.devDependencies['@types/vscode']}`);
  });

  it('has no publish script', () => {
    expect(Object.keys(pkg.scripts).filter((s) => s.includes('publish'))).toEqual([]);
  });

  it('packages only the license, the bundles and media', () => {
    expect(pkg.files).toEqual(['LICENSE', 'dist/extension.js', 'dist/webview.js', 'media/']);
  });

  it('activates after startup and when a window is restored', () => {
    expect(pkg.activationEvents).toEqual(['onStartupFinished', `onWebviewPanel:${VIEW_TYPE}`]);
  });
});

describe('commands', () => {
  const { commands, menus } = pkg.contributes;
  const hidden = new Set(
    menus.commandPalette.filter((m) => m.when === 'false').map((m) => m.command),
  );
  const visible = commands.filter((c) => !hidden.has(c.command)).map((c) => c.command);

  it('shows exactly the five commands of the spec in the palette', () => {
    expect(visible).toEqual([
      'vscodeExtDemo.openWindow',
      'vscodeExtDemo.sayHello',
      'vscodeExtDemo.increment',
      'vscodeExtDemo.reset',
      'vscodeExtDemo.showLog',
    ]);
  });

  it('declares exactly the commands the source uses, each once', () => {
    const declared = commands.map((c) => c.command);
    expect(new Set(declared).size).toBe(declared.length);
    expect([...declared].sort()).toEqual(Object.values(COMMANDS).sort());
  });

  it('puts every command in the category Demo and gives it a title', () => {
    for (const c of commands) {
      expect(c.category).toBe('Demo');
      expect(c.title).not.toBe('');
    }
  });

  it('has the internal settings command with an icon, hidden from the palette', () => {
    expect(hidden).toEqual(new Set([COMMANDS.openSettings]));
    expect(commands.find((c) => c.command === COMMANDS.openSettings)?.icon).toBe('$(gear)');
  });

  it('shows the settings command as the gear of the view title only', () => {
    expect(menus['view/title']).toEqual([
      { command: COMMANDS.openSettings, when: `view == ${VIEW_ID}`, group: 'navigation' },
    ]);
  });

  it('uses no command ID in src/ that is not in ids.ts', () => {
    const dir = new URL('../../src/', import.meta.url);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.ts') && f.name !== 'ids.ts')
      .map((f) => f.name);
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(readFileSync(new URL(name, dir), 'utf8'), name).not.toContain('vscodeExtDemo');
    }
  });
});

describe('settings', () => {
  const { properties, title } = pkg.contributes.configuration;

  it('has one section for the extension', () => {
    expect(title).toBe('Demo');
    for (const key of Object.keys(properties)) {
      expect(key.startsWith(`${CONFIG_SECTION}.`)).toBe(true);
    }
  });

  it('declares the four settings in this order, with the defaults of the spec', () => {
    expect(Object.entries(properties).map(([key, p]) => [key, p.type, p.default])).toEqual([
      ['vscodeExtDemo.message', 'string', 'Hello from kingofkalk!'],
      ['vscodeExtDemo.step', 'integer', 1],
      ['vscodeExtDemo.showStatusBar', 'boolean', true],
      ['vscodeExtDemo.openLocation', 'string', 'tab'],
    ]);
  });

  it('limits step to 1-100 and openLocation to tab and beside', () => {
    expect(properties['vscodeExtDemo.step']?.minimum).toBe(1);
    expect(properties['vscodeExtDemo.step']?.maximum).toBe(100);
    expect(properties['vscodeExtDemo.openLocation']?.enum).toEqual(['tab', 'beside']);
  });

  it('describes every setting', () => {
    for (const p of Object.values(properties)) {
      expect(p.description.length).toBeGreaterThan(10);
    }
  });
});

describe('sidebar', () => {
  it('has an activity bar container with an icon that exists', () => {
    const [container, ...rest] = pkg.contributes.viewsContainers.activitybar;
    expect(rest).toEqual([]);
    expect(container?.id).toBe(CONFIG_SECTION);
    expect(container?.title).toBe('Demo');
    expect(container?.icon).toBe('media/icon.svg');
    expect(existsSync(new URL('../../media/icon.svg', import.meta.url))).toBe(true);
  });

  it('has the actions view in that container', () => {
    expect(pkg.contributes.views).toEqual({
      [CONFIG_SECTION]: [{ id: VIEW_ID, name: 'Actions' }],
    });
  });
});
