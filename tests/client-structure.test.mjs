/**
 * 合并后 client.js 的结构核对（不依赖浏览器与宿主）：
 *   1. 内嵌的 markdown.js 副本与源文件逐字一致（防止两地漂移）；
 *   2. merged locale 字典是扁平点号键、zh/en 键集合一致、原两包 key 不冲突
 *      （meta.* 冲突按约定改名到 markdown.meta.*）；
 *   3. 在 stub 的 window/document/React 下执行 client.js，调用 apply()，确认
 *      原 dsh-markdown-composer 的三个槽位注册的 name / id / key / priority / order
 *      不变，且合并后的命令、Toast、探针也仍注册；
 *   4. 原 Markdown 包的兼容常量（localStorage key / data-dsh-markdown-source）
 *      与源码模式 CSS 规则保持不变，样式无硬编码颜色。
 *
 * 运行：node --test tests/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function embeddedParser() {
  const client = read('client.js');
  const begin = client.indexOf('// --- BEGIN markdown.js ---');
  const end = client.indexOf('// --- END markdown.js ---');
  assert.ok(begin > 0 && end > begin, 'client.js 缺少 BEGIN/END 标记');
  const body = client.slice(begin + '// --- BEGIN markdown.js ---'.length, end);
  return body
    .split('\n')
    .map((line) => (line.startsWith('    ') ? line.slice(4) : line))
    .join('\n')
    .trim();
}

test('client.js 内嵌的 markdown 解析器与 markdown.js 逐字一致', () => {
  const source = read('markdown.js').replaceAll('export function', 'function').trim();
  const embedded = embeddedParser();
  assert.equal(embedded, source);
});

/** 最小 React stub：覆盖 client.js 里用到的 hooks（不渲染组件）。 */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    Fragment: 'fragment',
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value ?? null }),
    useMemo: (factory) => factory(),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
}

async function loadClient({ modeValue = null } = {}) {
  const registrations = [];
  const locales = [];
  const commands = [];
  const docker = [];
  const styleTags = [];
  const attributes = new Map();
  const storageKeys = { reads: [], writes: [] };

  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: {
      value: modeValue,
      getItem(key) {
        storageKeys.reads.push(key);
        return this.value;
      },
      setItem(key, value) {
        storageKeys.writes.push({ key, value });
        this.value = value;
      },
    },
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => {
      fn();
      return 0;
    },
    __ModuleLoader__: {
      load(definition) {
        globalThis.__capturedPlugin = definition;
      },
    },
  };
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    head: {
      appendChild(node) {
        styleTags.push(node);
      },
    },
    querySelector: () => null,
    createElement: (tag) => ({
      tag,
      dataset: {},
      textContent: '',
      remove() {
        const index = styleTags.indexOf(this);
        if (index >= 0) styleTags.splice(index, 1);
      },
    }),
    documentElement: {
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
    },
  };

  const url = pathToFileURL(path.join(root, 'client.js')).href + `?t=${Date.now()}`;
  await import(url);
  const definition = globalThis.__capturedPlugin;
  assert.ok(definition, '客户端模块没有调用 window.__ModuleLoader__.load');
  assert.equal(definition.id, '@jason25417/dsh-composer-tweaks');

  const module = definition.factory((name) => {
    assert.equal(name, 'react');
    return reactStub();
  });
  assert.deepEqual(module.inject, ['slots', 'locale', 'commandUi']);

  const slots = {
    inject(owner, callback) {
      const disposer = callback();
      docker.push({ owner, disposer });
    },
    register(options, component) {
      registrations.push({ ...options, component });
      return () => {};
    },
  };
  const ctx = {
    get: () => undefined,
    slots,
    locale: {
      register(namespace, dict) {
        locales.push({ namespace, dict });
        return () => {};
      },
      bind() {
        return (key) => key;
      },
    },
    commandUi: {
      register(contribution) {
        commands.push(contribution);
        return () => {};
      },
    },
    effect(fn) {
      const disposer = fn();
      return disposer;
    },
  };
  module.apply(ctx);
  return { registrations, locales, commands, docker, styleTags, attributes, storageKeys };
}

test('apply() 仍注册原 tweaks 的命令 / Toast / 探针，以及 Markdown 的三个槽位', async () => {
  const { registrations, commands } = await loadClient();

  // ---- 原 dsh-markdown-composer：三个槽位（name / id / key / priority 保持） ----
  const toggle = registrations.find((entry) => entry.id === 'markdown-composer-toggle');
  assert.ok(toggle, '缺少输入框下方的开关注册');
  assert.equal(toggle.name, 'conversation.composer.dock');
  assert.equal(toggle.order, 2);
  assert.equal(toggle.locale, 'dsh-composer-tweaks');
  assert.equal(typeof toggle.component, 'function');

  const source = registrations.find((entry) => entry.id === 'markdown-composer-source');
  assert.ok(source, '缺少源码输入面板注册');
  assert.equal(source.name, 'conversation.input.dock');
  assert.equal(source.order, 70);
  assert.equal(typeof source.component, 'function');

  const userText = registrations.find((entry) => entry.name === 'conversation.user.text.node');
  assert.ok(userText, '缺少用户消息 Markdown 渲染注册');
  assert.equal(userText.key, 'text');
  assert.equal(userText.priority, 0, '必须以更低 priority 替换宿主内置的 text 渲染器');
  assert.equal(typeof userText.component, 'function');

  // ---- 原 dsh-composer-tweaks：Toast / 探针 / 两个命令 ----
  assert.ok(registrations.find((entry) => entry.id === 'composer-tweaks-toast'), '缺少 Toast 浮层注册');
  assert.ok(registrations.find((entry) => entry.id === 'composer-tweaks-probe'), '缺少 composer.dock 探针');
  assert.deepEqual(commands.map((command) => command.name).sort(), ['files-and-folders', 'genui-prompt']);
});

test('合并后的 locale 字典：单一命名空间、扁平点号键、zh/en 键一致、冲突已改名', async () => {
  const { locales } = await loadClient();
  assert.equal(locales.length, 1, '合并后只应注册一份字典');
  assert.equal(locales[0].namespace, 'dsh-composer-tweaks');

  const { zh, en } = locales[0].dict;
  // 宿主 locale 服务只认扁平点号键：所有 key 必须是 a.b 形式，不能有嵌套对象。
  const flatKey = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;
  for (const [name, dict] of [['zh', zh], ['en', en]]) {
    for (const key of Object.keys(dict)) {
      assert.match(key, flatKey, `${name} 字典存在非扁平 key: ${key}`);
      assert.equal(typeof dict[key], 'string', `${name}.${key} 必须是字符串`);
    }
  }
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh/en 键集合必须一致');

  // 原 Markdown 包的 key 全部保留（toggle.* / source.*），meta.* 冲突改名为 markdown.meta.*。
  for (const key of [
    'toggle.source', 'toggle.view', 'toggle.toSourceHint', 'toggle.toViewHint',
    'source.title', 'source.hint', 'source.placeholder', 'source.sendHint', 'source.back',
  ]) {
    assert.ok(Object.hasOwn(zh, key), `缺少原 Markdown 包的 key: ${key}`);
  }
  assert.ok(Object.hasOwn(zh, 'markdown.meta.title'), '冲突的 meta.title 应改名保留');
  assert.ok(Object.hasOwn(zh, 'markdown.meta.description'), '冲突的 meta.description 应改名保留');
  assert.notEqual(zh['markdown.meta.title'], zh['meta.title'], '改名后的 key 不能和合并文案相同');

  // 原 tweaks 的 key 也都在。
  for (const key of ['genui.labelOn', 'genui.descriptionOff', 'pick.label', 'pick.unavailable']) {
    assert.ok(Object.hasOwn(zh, key), `缺少原 tweaks 的 key: ${key}`);
  }
  assert.ok(zh['meta.title'].length > 0 && en['meta.title'].length > 0);
  assert.match(zh['meta.description'], /GenUI/);
  assert.match(zh['meta.description'], /Markdown/);
});

test('样式：单一 style 标签，合并两包规则，无硬编码颜色', async () => {
  const { styleTags } = await loadClient();
  assert.equal(styleTags.length, 1, '应该只注入一份合并后的插件样式');
  const css = styleTags[0].textContent;

  // 原 tweaks 的规则
  assert.match(css, /button\[aria-label="GenUI prompt"\]\{display:none!important\}/);
  assert.match(css, /\.dmct-toast\{/);
  // 原 Markdown 包的规则
  assert.match(css, /data-dsh-markdown-source/);
  assert.match(css, /\.dmc-toggle\{/);
  assert.match(css, /\.dmc-source-input\{/);
  assert.match(css, /\.dmc-md\{/);
  assert.match(css, /--dsw-alias-/);
  assert.equal(styleTags[0].dataset.plugin, '@jason25417/dsh-composer-tweaks');

  // 插件规范：颜色必须走主题 token；只允许透明/继承这类关键字。
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, []);
});

test('源码模式隐藏宿主输入区的 CSS 规则与兼容常量保持不变', async () => {
  const { styleTags } = await loadClient();
  const css = styleTags[0].textContent;
  assert.match(css, /html\[data-dsh-markdown-source="true"\] \[data-input-scroll\]\{display:none!important\}/);

  // 用户设置不丢：localStorage key 不能改；宿主选择器依赖的 data 属性不能改。
  const client = read('client.js');
  assert.match(client, /MODE_KEY = 'dsh-markdown-composer\.mode'/);
  assert.match(client, /SOURCE_ATTR = 'data-dsh-markdown-source'/);
});

/** 把 createElement stub 出来的元素树里的文本节点按顺序收集起来。 */
function flattenText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) flattenText(child, out);
    return out;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (node.props) flattenText(node.props.children, out);
  return out;
}

test('用户消息按 Markdown 渲染：内嵌解析器 → 元素树（标题/列表/粗体/代码/引用）', async () => {
  const { registrations } = await loadClient();
  const userText = registrations.find((entry) => entry.name === 'conversation.user.text.node');
  const tree = userText.component({ node: { data: { text: '# 标题\n\n- **粗**\n- `code`\n\n> 引用' } } });
  const texts = flattenText(tree);
  assert.ok(texts.includes('标题'), '标题没有渲染成文本');
  assert.ok(texts.includes('粗'), '粗体内容没有渲染');
  assert.ok(texts.includes('code'), '行内代码没有渲染');
  assert.ok(texts.includes('引用'), '引用内容没有渲染');
  assert.ok(texts.includes('•'), '无序列表的项目符号没有渲染');
});

test('模式记忆：localStorage key 保持 dsh-markdown-composer.mode，source 恢复源码态', async () => {
  const { registrations, storageKeys } = await loadClient({ modeValue: 'source' });
  const toggle = registrations.find((entry) => entry.id === 'markdown-composer-toggle');
  const props = toggle.inject();
  assert.equal(props.mode.get(), true, '存了 source 就应该恢复源码模式');
  const view = toggle.component({ ...props, t: (key) => key });
  assert.equal(view.props.children[0].props['aria-pressed'], true);

  props.mode.set(false);
  assert.deepEqual(storageKeys.writes, [{ key: 'dsh-markdown-composer.mode', value: 'view' }]);
  assert.deepEqual(storageKeys.reads, ['dsh-markdown-composer.mode']);
});
