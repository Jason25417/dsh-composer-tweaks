/**
 * composer-tweaks 的 Client 半结构 / 行为测试（不依赖浏览器与宿主）。
 *
 * 运行：node --test tests/
 *
 * 用 stub 的 window/document/React/commandUi/ctx 执行 client.js，核对：
 *   · 隐藏 GenUI 按钮的样式规则；
 *   · 两个菜单命令（GenUI 开关 / 文件与文件夹）的注册参数；
 *   · GenUI 状态读取与切换；
 *   · 混合选择命令：调宿主路由 → 生成 file/folder 引用 → shell.addFiles → Toast；
 *   · 取消、失败、空选择三条路径；
 *   · Toast 浮层注册与探针注册。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function reactStub() {
  const noopEffect = () => {};
  return {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    Fragment: 'fragment',
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: noopEffect,
    useRef: (value) => ({ current: value ?? null }),
    useMemo: (factory) => factory(),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
}

function installDom() {
  const tags = [];
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => {
      fn();
      return 1;
    },
    // 合并后的 Markdown 开关用 localStorage 记忆模式（默认视图）。
    localStorage: {
      value: null,
      getItem() {
        return this.value;
      },
      setItem(_key, value) {
        this.value = value;
      },
    },
    __ModuleLoader__: {
      load(definition) {
        globalThis.__capturedTweaks = definition;
      },
    },
  };
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    head: {
      appendChild(node) {
        tags.push(node);
      },
    },
    querySelector: () => null,
    createElement: () => ({
      dataset: {},
      textContent: '',
      remove() {
        const index = tags.indexOf(this);
        if (index >= 0) tags.splice(index, 1);
      },
    }),
    // 源码模式组件的 effect 会改这个属性（组件在测试里不真正渲染，stub 备齐）。
    documentElement: {
      setAttribute: () => {},
      removeAttribute: () => {},
    },
  };
  return tags;
}

function makeFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected fetch ${url}`);
    const body = await route(options);
    return { ok: body.ok !== false, json: async () => body };
  };
  return calls;
}

async function loadAndApply({ routes = {}, services = {} } = {}) {
  const tags = installDom();
  const calls = makeFetch(routes);
  const url = pathToFileURL(path.join(root, 'client.js')).href + `?t=${Date.now()}`;
  await import(url);
  const definition = globalThis.__capturedTweaks;
  assert.ok(definition, '客户端模块没有调用 window.__ModuleLoader__.load');
  assert.equal(definition.id, '@jason25417/dsh-composer-tweaks');

  const module = definition.factory((name) => {
    assert.equal(name, 'react');
    return reactStub();
  });
  assert.deepEqual(module.inject, ['slots', 'locale', 'commandUi']);

  const locales = [];
  const commands = [];
  const slotRegistrations = [];
  const ctx = {
    get: (name) => services[name],
    effect(fn) {
      fn();
    },
    locale: {
      register(namespace, dictionaries) {
        locales.push({ namespace, dictionaries });
        return () => {};
      },
      bind() {
        return (key, params) => {
          const zh = locales[0].dictionaries.zh;
          const flat = zh[key];
          const template = typeof flat === 'string'
            ? flat
            : key.split('.').reduce((node, part) => (node === undefined ? node : node[part]), zh);
          if (typeof template !== 'string') return key;
          return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
        };
      },
    },
    commandUi: {
      register(contribution) {
        commands.push(contribution);
        return () => {};
      },
    },
    slots: {
      inject(owner, callback) {
        callback();
      },
      register(options, component) {
        slotRegistrations.push({ ...options, component });
        return () => {};
      },
    },
  };
  module.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { tags, calls, locales, commands, slotRegistrations };
}

const findCommand = (commands, name) => {
  const found = commands.find((command) => command.name === name);
  assert.ok(found, `缺少命令 ${name}`);
  return found;
};

test('样式：隐藏 GenUI 输入框按钮 + Toast 样式', async () => {
  const { tags } = await loadAndApply();
  assert.equal(tags.length, 1);
  const css = tags[0].textContent;
  assert.match(css, /button\[aria-label="GenUI prompt"\]\{display:none!important\}/);
  assert.match(css, /\.dmct-toast\{/);
  assert.match(css, /\.dmct-row-action\{/);
});

test('两个菜单命令都注册：genui-prompt / files-and-folders', async () => {
  const { commands } = await loadAndApply();
  assert.deepEqual(commands.map((command) => command.name).sort(), ['files-and-folders', 'genui-prompt']);
  for (const command of commands) {
    assert.equal(command.ui.kind, 'action');
    assert.equal(typeof command.ui.run, 'function');
    assert.equal(command.available(), true);
    assert.equal(typeof command.icon, 'function');
  }
});

test('GenUI：初始关闭 → label/description；点击 → POST 取反', async () => {
  const { commands, calls } = await loadAndApply({
    routes: {
      '/api/dsh-genui/prompt': async (options) => (options.method === 'POST'
        ? { enabled: JSON.parse(options.body).enabled === true }
        : { enabled: false }),
    },
  });
  const command = findCommand(commands, 'genui-prompt');
  assert.match(command.label(), /（关）/);
  command.ui.run({ sessionId: 's1' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const post = calls.find((call) => call.options.method === 'POST' && call.url === '/api/dsh-genui/prompt');
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.options.body), { enabled: true });
  assert.match(command.label(), /（开）/);
});

test('文件与文件夹：混合选择 → file/folder 引用 → addFiles → Toast', async () => {
  const added = [];
  const shell = {
    addFiles(references) {
      added.push(references);
      return true;
    },
  };
  const { commands, slotRegistrations } = await loadAndApply({
    routes: {
      '/api/dsh-genui/prompt': async () => ({ enabled: false }),
      '/api/dsh-composer/pick': async () => ({
        ok: true,
        paths: [
          { path: '/tmp/dsh-ws/notes.md', isDirectory: false },
          { path: '/tmp/dsh-ws/sub dir', isDirectory: true },
        ],
      }),
    },
    services: {
      conversation: { input: { shell: () => shell } },
      sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: '/tmp/dsh-ws' } } }) } },
    },
  });

  const command = findCommand(commands, 'files-and-folders');
  assert.equal(command.label(), '选择文件或文件夹');
  command.ui.run({ sessionId: 's1' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(added.length, 1);
  const references = added[0];
  assert.equal(references.length, 2);
  assert.deepEqual(references[0], {
    source: 'reference',
    ref: '@notes.md',
    label: 'notes.md',
    appearance: 'file',
    clipboardText: '@notes.md',
  });
  assert.deepEqual(references[1], {
    source: 'reference',
    ref: '@"sub dir/"',
    label: 'sub dir/',
    appearance: 'folder',
    clipboardText: '@"sub dir/"',
  });

  // Toast 通过 shell.overlay 注册，直接取组件 inject 的 store 检查回执
  const toastEntry = slotRegistrations.find((entry) => entry.id === 'composer-tweaks-toast');
  assert.ok(toastEntry, '缺少 Toast 浮层注册');
});

test('文件与文件夹：取消 / 失败 / 空选择都不插入', async () => {
  const added = [];
  const shell = { addFiles: (references) => (added.push(references), true) };
  const services = {
    conversation: { input: { shell: () => shell } },
    sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: '/tmp/dsh-ws' } } }) } },
  };

  // 取消：paths 为 []
  {
    const { commands } = await loadAndApply({
      routes: {
        '/api/dsh-genui/prompt': async () => ({ enabled: false }),
        '/api/dsh-composer/pick': async () => ({ ok: true, paths: [] }),
      },
      services,
    });
    findCommand(commands, 'files-and-folders').ui.run({ sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // 宿主返回失败
  {
    const { commands } = await loadAndApply({
      routes: {
        '/api/dsh-genui/prompt': async () => ({ enabled: false }),
        '/api/dsh-composer/pick': async () => ({ ok: false, error: { code: 'unsupported-platform', message: 'no' } }),
      },
      services,
    });
    findCommand(commands, 'files-and-folders').ui.run({ sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(added.length, 0);
});

test('侧栏行左侧：注册 agent 创建标记（未知 session 返回 null）', async () => {
  const { slotRegistrations } = await loadAndApply();
  const entry = slotRegistrations.find((item) => item.id === 'composer-tweaks-agent-mark');
  assert.ok(entry, '缺少 agent 标记注册');
  assert.equal(entry.name, 'sidebar.session.row.leading');
  assert.equal(entry.order, 5);
  assert.equal(entry.component({ sessionId: 'unknown' }), null);
});

test('侧栏会话行：注册「在新窗口打开」并调 /popout/open', async () => {
  const { slotRegistrations, calls } = await loadAndApply({
    routes: {
      '/api/dsh-genui/prompt': async () => ({ enabled: false }),
      '/popout/open': async () => ({ ok: true }),
    },
  });
  const entry = slotRegistrations.find((item) => item.id === 'composer-tweaks-popout');
  assert.ok(entry, '缺少侧栏行按钮注册');
  assert.equal(entry.name, 'sidebar.workspaces.session.row.action');
  assert.equal(entry.order, 200);
  const element = entry.component({ sessionId: 's1' });
  assert.equal(element.props.className, 'dmct-row-action');
  element.props.onClick({ preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const call = calls.find((item) => item.url === '/popout/open');
  assert.ok(call, '没有请求 /popout/open');
  assert.equal(call.options.method, 'POST');
  assert.deepEqual(JSON.parse(call.options.body), { sessionId: 's1' });
});

test('探针注册在 composer.dock（插件活性可被 Slots 观察到）', async () => {
  const { slotRegistrations } = await loadAndApply();
  const probe = slotRegistrations.find((entry) => entry.id === 'composer-tweaks-probe');
  assert.ok(probe, '缺少 composer.dock 探针');
  assert.equal(probe.name, 'conversation.composer.dock');
});
