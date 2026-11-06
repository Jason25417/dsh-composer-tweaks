/**
 * dsh-composer-tweaks — Client 半（0.2.0 起合并了 dsh-markdown-composer 的全部功能）。
 *
 * 五件事：
 *   1. 隐藏 GenUI 在输入框左侧的小按钮（`aria-label="GenUI prompt"`）。
 *   2. 把「GenUI 提示词」开关放进左下角加号的扩展菜单（command contribution），
 *      菜单项实时显示开关状态。
 *   3. 把「添加文件」与「添加文件夹」合并成加号菜单里的**一个**条目
 *      「文件或文件夹」：调用宿主路由 `POST /api/dsh-composer/pick`（Host 半实现，
 *      macOS NSOpenPanel，可同时多选文件与文件夹），把选中的路径按宿主
 *      拖拽同款语义插进输入框（文件夹/普通文件 → @引用 chip，二进制内容不复制）。
 *   4. 输入框下方加一颗「源码 / 视图」小开关：源码模式在输入框上方铺一块等宽
 *      textarea 写 Markdown（实时写回宿主草稿，⌘/Ctrl+Enter 发送），localStorage
 *      记忆（key 沿用 `dsh-markdown-composer.mode`），并用
 *      `html[data-dsh-markdown-source="true"]` 隐藏宿主原生输入区。
 *   5. 聊天记录里的**用户消息**按 Markdown 渲染（`conversation.user.text.node` 的
 *      `text` 键、priority 0 替换宿主纯文本渲染器；助手消息宿主本来就会渲染）。
 *
 * 约束（来自插件规范）：
 *   · 不 import 任何 `@deepseek-ai/*` 包，只用 `require('react')`；
 *   · 样式全部用主题 token（`--dsw-alias-*`），不写死颜色；
 *   · 不替换应用根、不往 document.body 追加东西；所有注册都在 `apply` 里用 ctx.effect 管生命周期。
 *
 * 文件里嵌入了 markdown.js 的**逐字副本**（浏览器模块不能相对 import），
 * tests/client-structure.test.mjs 会核对两边一致。
 */
window.__ModuleLoader__.load({
  id: '@jason25417/dsh-composer-tweaks',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-composer-tweaks';
    const STYLE_ID = 'dsh-composer-tweaks-style';

    /* 以下两个常量来自原 dsh-markdown-composer：保持原值（用户设置不丢、宿主选择器不变）。 */
    const MODE_KEY = 'dsh-markdown-composer.mode';
    const SOURCE_ATTR = 'data-dsh-markdown-source';

    const GENUI_PROMPT_URL = '/api/dsh-genui/prompt';
    const PICK_URL = '/api/dsh-composer/pick';
    const REFRESH_MS = 10_000;
    const TOAST_MS = 3200;

    /** GenUI 的输入框按钮：GenUI 用固定英文 aria-label 标记它。 */
    const GENUI_SELECTOR = 'button[aria-label="GenUI prompt"]';

    /* ================================================================== *
     * 嵌入的 markdown.js（BEGIN/END 之间逐字同步；测试会核对）
     * ================================================================== */
    // --- BEGIN markdown.js ---
    /**
     * markdown.js — 零依赖的 Markdown 子集解析器（纯函数，可单测）。
     *
     * 为什么要自己写：DSH 的 Client 插件运行在浏览器模块表里，只能 `require('react')`，
     * 拿不到 npm 上的 markdown 库；而 Chat 里助手消息本来就会渲染 markdown，用户消息
     * 目前是纯文本，需要我们自己补一个够用的解析器。
     *
     * 支持：
     *   · 块级：ATX 标题（# ~ ######）、围栏代码块（``` / ~~~，带语言标记）、
     *     引用块（>）、无序 / 有序列表（单层）、水平线、段落
     *   · 行内：`code`、**粗体** / __粗体__、*斜体* / _斜体_、~~删除线~~、
     *     [文字](http(s)/mailto 链接)，反斜杠转义
     *
     * 刻意不支持（宁可显示原文，也不猜）：原始 HTML（一律按文本显示，防 XSS）、
     * 表格、嵌套列表、脚注、任务列表。不认识的语法原样保留为文本。
     *
     * 返回结构是纯数据（不依赖 React），渲染在 client.js 里做；同一份函数体在
     * client.js 中被内联（浏览器模块不能相对 import），`tests/markdown.test.mjs`
     * 会逐字节核对两边一致。
     */

    /** 行内解析：文本 / 代码 / 强调 / 删除线 / 链接。 */
    function parseInline(source) {
      const text = String(source ?? '');
      const nodes = [];
      let buffer = '';
      let i = 0;

      const flush = () => {
        if (buffer !== '') {
          nodes.push({ type: 'text', text: buffer });
          buffer = '';
        }
      };

      while (i < text.length) {
        const ch = text[i];

        // 反斜杠转义：\* 之类按字面量
        if (ch === '\\' && i + 1 < text.length) {
          buffer += text[i + 1];
          i += 2;
          continue;
        }

        // 行内代码：`...`（成对的单反引号；内容不递归解析）
        if (ch === '`') {
          const end = text.indexOf('`', i + 1);
          if (end > i + 1) {
            flush();
            nodes.push({ type: 'code', text: text.slice(i + 1, end) });
            i = end + 1;
            continue;
          }
        }

        // 链接：[label](url)
        if (ch === '[') {
          const close = text.indexOf(']', i + 1);
          if (close > i + 1 && text[close + 1] === '(') {
            const end = text.indexOf(')', close + 2);
            if (end > close + 2) {
              const href = text.slice(close + 2, end).trim();
              if (isSafeHref(href)) {
                flush();
                nodes.push({
                  type: 'link',
                  href,
                  children: parseInline(text.slice(i + 1, close)),
                });
                i = end + 1;
                continue;
              }
            }
          }
        }

        // 强调：** / __ 优先于 * / _
        const two = text.slice(i, i + 2);
        if (two === '**' || two === '__') {
          const end = text.indexOf(two, i + 2);
          if (end > i + 2) {
            flush();
            nodes.push({ type: 'strong', children: parseInline(text.slice(i + 2, end)) });
            i = end + 2;
            continue;
          }
        }

        // 删除线：~~
        if (two === '~~') {
          const end = text.indexOf('~~', i + 2);
          if (end > i + 2) {
            flush();
            nodes.push({ type: 'del', children: parseInline(text.slice(i + 2, end)) });
            i = end + 2;
            continue;
          }
        }

        if (ch === '*' || ch === '_') {
          const end = text.indexOf(ch, i + 1);
          // 必须后面有内容、且不是空强调；避免把 "2 * 3" 之类误判
          if (end > i + 1 && !/\s/.test(text[i + 1])) {
            flush();
            nodes.push({ type: 'em', children: parseInline(text.slice(i + 1, end)) });
            i = end + 1;
            continue;
          }
        }

        buffer += ch;
        i += 1;
      }

      flush();
      return nodes;
    }

    /** 只放行 http(s) / mailto：其它协议按文本渲染，避免 javascript: 之类进入 <a>。 */
    function isSafeHref(href) {
      return /^(https?:\/\/|mailto:)/i.test(String(href ?? '').trim());
    }

    /**
     * 块级解析。
     * @returns {Array<{type:string,...}>} 按出现顺序的块；每种块形如
     *   heading {level, children} / code {lang, text} / quote {children} /
     *   list {ordered, items: Array<{children}>} / hr / paragraph {children}
     */
    function parseMarkdown(source) {
      const text = String(source ?? '').replace(/\r\n?/g, '\n');
      const lines = text.split('\n');
      const blocks = [];
      let i = 0;

      const isBlank = (line) => /^\s*$/.test(line);
      const startsBlock = (line) =>
        /^\s{0,3}(`{3,}|~{3,})/.test(line)
        || /^\s{0,3}#{1,6}\s/.test(line)
        || /^\s{0,3}>/.test(line)
        || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
        || /^\s{0,3}([-*+]|\d{1,9}[.)])\s/.test(line);

      while (i < lines.length) {
        const line = lines[i];
        if (isBlank(line)) {
          i += 1;
          continue;
        }

        // 围栏代码块
        const fence = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
        if (fence) {
          const marker = fence[1];
          const lang = fence[2] ?? '';
          const body = [];
          i += 1;
          while (i < lines.length) {
            const current = lines[i];
            if (new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(current)) {
              i += 1;
              break;
            }
            body.push(current);
            i += 1;
          }
          blocks.push({ type: 'code', lang, text: body.join('\n') });
          continue;
        }

        // 标题
        const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
          blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
          i += 1;
          continue;
        }

        // 水平线
        if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
          blocks.push({ type: 'hr' });
          i += 1;
          continue;
        }

        // 引用块：连续的 > 行
        if (/^\s{0,3}>/.test(line)) {
          const body = [];
          while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
            body.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
            i += 1;
          }
          blocks.push({ type: 'quote', children: parseInline(body.join('\n')) });
          continue;
        }

        // 列表（单层；缩进更深的行并入上一项）
        const listMatch = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
        if (listMatch) {
          const ordered = /^\d/.test(listMatch[1]);
          const items = [];
          while (i < lines.length) {
            const item = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i]);
            if (item !== null) {
              items.push({ text: item[2] });
              i += 1;
              continue;
            }
            // 段内续行（缩进或非空且不是新块）并入最后一项
            if (!isBlank(lines[i]) && !startsBlock(lines[i]) && items.length > 0) {
              items[items.length - 1].text += `\n${lines[i].trim()}`;
              i += 1;
              continue;
            }
            break;
          }
          blocks.push({ type: 'list', ordered, items: items.map((item) => ({ children: parseInline(item.text) })) });
          continue;
        }

        // 段落：吃到一个空行或下一个块开始
        const body = [];
        while (i < lines.length && !isBlank(lines[i]) && (body.length === 0 || !startsBlock(lines[i]))) {
          body.push(lines[i]);
          i += 1;
        }
        blocks.push({ type: 'paragraph', children: parseInline(body.join('\n')) });
      }

      return blocks;
    }
    // --- END markdown.js ---

    /* ================================================================== *
     * 渲染
     * ================================================================== */

    function renderInline(nodes, keyPrefix = 'i') {
      const out = [];
      nodes.forEach((node, index) => {
        const key = `${keyPrefix}${index}`;
        switch (node.type) {
          case 'code':
            out.push(h('code', { key, className: 'dmc-inline-code' }, node.text));
            break;
          case 'strong':
            out.push(h('strong', { key }, renderInline(node.children, `${key}-`)));
            break;
          case 'em':
            out.push(h('em', { key }, renderInline(node.children, `${key}-`)));
            break;
          case 'del':
            out.push(h('del', { key }, renderInline(node.children, `${key}-`)));
            break;
          case 'link':
            out.push(h('a', {
              key,
              className: 'dmc-link',
              href: node.href,
              target: '_blank',
              rel: 'noreferrer noopener',
            }, renderInline(node.children, `${key}-`)));
            break;
          default:
            out.push(node.text);
        }
      });
      return out;
    }

    function renderBlocks(blocks) {
      return blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.type) {
          case 'heading':
            return h('span', {
              key,
              className: `dmc-block dmc-h dmc-h${block.level}`,
              role: 'heading',
              'aria-level': block.level,
            }, renderInline(block.children, `${key}-`));
          case 'code':
            return h('span', { key, className: 'dmc-block dmc-pre-wrap' },
              block.lang === '' ? null : h('span', { className: 'dmc-pre-lang' }, block.lang),
              h('span', { className: 'dmc-block dmc-pre' }, block.text));
          case 'quote':
            return h('span', { key, className: 'dmc-block dmc-quote' }, renderInline(block.children, `${key}-`));
          case 'list':
            return h('span', { key, className: 'dmc-block dmc-list' }, block.items.map((item, itemIndex) => h('span', {
              key: `${key}-${itemIndex}`,
              className: 'dmc-li',
            }, h('span', { className: 'dmc-li-mark' }, block.ordered ? `${itemIndex + 1}.` : '•'),
              h('span', { className: 'dmc-li-body' }, renderInline(item.children, `${key}-${itemIndex}-`)))));
          case 'hr':
            return h('span', { key, className: 'dmc-block dmc-hr', role: 'separator' });
          default:
            return h('span', { key, className: 'dmc-block dmc-p' }, renderInline(block.children, `${key}-`));
        }
      });
    }

    /** 聊天记录里的用户消息：按 Markdown 渲染（替换宿主纯文本渲染器）。 */
    function MarkdownUserText(props) {
      const node = props.node ?? {};
      const data = node.data ?? {};
      const source = typeof data.display === 'string' ? data.display
        : typeof data.text === 'string' ? data.text
          : typeof props.raw === 'string' ? props.raw : '';
      const blocks = React.useMemo(() => parseMarkdown(source), [source]);
      if (blocks.length === 0) return null;
      return h('span', { className: 'dmc-md' }, renderBlocks(blocks));
    }

    /* ================================================================== *
     * 模式开关（localStorage 记忆）
     * ================================================================== */

    function createModeStore() {
      let stored = false;
      try {
        stored = window.localStorage.getItem(MODE_KEY) === 'source';
      } catch {
        stored = false;
      }
      let value = stored;
      const listeners = new Set();
      return {
        get: () => value,
        set: (next) => {
          const normalized = next === true;
          if (normalized === value) return;
          value = normalized;
          try {
            window.localStorage.setItem(MODE_KEY, normalized ? 'source' : 'view');
          } catch {
            /* 隐私模式/配额满：不记忆也不影响本次会话 */
          }
          for (const listener of listeners) listener();
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    function useModeValue(mode) {
      return React.useSyncExternalStore(mode.subscribe, mode.get, mode.get);
    }

    /** 输入框下方的开关：源码 / 视图。 */
    function ModeToggle(props) {
      const t = typeof props.t === 'function' ? props.t : (text) => text;
      const mode = props.mode;
      const source = useModeValue(mode);
      return h('div', { className: 'dmc-toggle-row' },
        h('button', {
          type: 'button',
          className: 'dmc-toggle',
          'aria-pressed': source,
          title: source ? t('toggle.toViewHint') : t('toggle.toSourceHint'),
          onClick: () => mode.set(!source),
        },
        h('span', { className: 'dmc-toggle-glyph', 'aria-hidden': true }, source ? '</>' : '¶'),
        h('span', { children: source ? t('toggle.source') : t('toggle.view') })));
    }

    /* ================================================================== *
     * 源码编辑面板
     * ================================================================== */

    function SourcePanelBody(props) {
      const { useInput, inputActions } = props;
      const t = props.t ?? ((text) => text);
      const draft = useInput((state) => (state !== null && state !== undefined && typeof state.draft === 'string' ? state.draft : ''));
      const [text, setText] = React.useState(draft);
      const ref = React.useRef(null);
      const appliedRef = React.useRef(false);

      // 外部改动（恢复草稿、发送后清空、别的入口 setDraft）同步进来；
      // 自己敲字时 draft 会等于 text，不会回灌覆盖光标。
      React.useEffect(() => {
        if (draft !== text) setText(draft);
        // 只在 draft 变化时判断，text 用 ref 读最新值
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [draft]);

      React.useEffect(() => {
        document.documentElement.setAttribute(SOURCE_ATTR, 'true');
        const timer = window.setTimeout(() => {
          const element = ref.current;
          if (element !== null) {
            element.focus();
            const end = element.value.length;
            element.setSelectionRange(end, end);
          }
        }, 0);
        return () => {
          window.clearTimeout(timer);
          document.documentElement.removeAttribute(SOURCE_ATTR);
        };
      }, []);

      const push = (value) => {
        try {
          inputActions.setDraft(value);
          appliedRef.current = true;
        } catch {
          /* 宿主在提交中/冻结时拒绝写入：保留本地文本，下一次输入或切回时再试 */
        }
      };

      const onChange = (event) => {
        const value = event.target.value;
        setText(value);
        push(value);
      };

      const onKeyDown = (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          try {
            inputActions.submit();
          } catch {
            /* 忙/冻结时宿主自己会拒绝 */
          }
        }
      };

      const onBlur = () => {
        if (!appliedRef.current) push(text);
      };

      return h('div', { className: 'dmc-source' },
        h('div', { className: 'dmc-source-head' },
          h('span', { className: 'dmc-source-title' }, t('source.title')),
          h('span', { className: 'dmc-source-hint' }, t('source.hint'))),
        h('textarea', {
          ref,
          className: 'dmc-source-input',
          value: text,
          onChange,
          onKeyDown,
          onBlur,
          spellCheck: false,
          wrap: 'off',
          rows: 6,
          placeholder: t('source.placeholder'),
          'aria-label': t('source.title'),
        }),
        h('div', { className: 'dmc-source-foot' },
          h('span', { children: t('source.sendHint') }),
          h('button', {
            type: 'button',
            className: 'dmc-source-back',
            onClick: () => props.mode.set(false),
          }, t('source.back'))));
    }

    /** 视图模式下不渲染；源码模式下挂载。hooks 拆到子组件保证调用顺序稳定。 */
    function SourcePanel(props) {
      const mode = props.mode;
      const source = useModeValue(mode);
      if (!source) return null;
      return h(SourcePanelBody, { ...props, mode });
    }

    /* ------------------------------------------------------------------ *
     * GenUI 开关状态
     * ------------------------------------------------------------------ */

    function createGenuiState() {
      let value = { enabled: false, available: false, error: null };
      return {
        get: () => value,
        set: (next) => {
          value = next;
        },
      };
    }

    async function fetchGenuiState() {
      const response = await fetch(GENUI_PROMPT_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const state = await response.json();
      return { enabled: state !== null && state.enabled === true, available: true, error: null };
    }

    async function writeGenuiState(enabled) {
      const response = await fetch(GENUI_PROMPT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const state = await response.json();
      return { enabled: state !== null && state.enabled === true, available: true, error: null };
    }

    /* ------------------------------------------------------------------ *
     * 轻量 Toast（command 的 action 没有通知通道，这里给合并入口做回执）
     * ------------------------------------------------------------------ */

    function createToastStore() {
      let value = null;
      let seq = 0;
      let timer = null;
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener();
      };
      return {
        get: () => value,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        publish: (level, text) => {
          seq += 1;
          value = { level, text, seq };
          if (timer !== null) window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            timer = null;
            value = null;
            emit();
          }, TOAST_MS);
          emit();
        },
        dispose: () => {
          if (timer !== null) window.clearTimeout(timer);
          timer = null;
          value = null;
          listeners.clear();
        },
      };
    }

    function ToastOverlay(props) {
      const toast = React.useSyncExternalStore(props.toast.subscribe, props.toast.get, props.toast.get);
      if (toast === null) return null;
      return h('div', {
        className: 'dmct-toast',
        role: 'status',
        'data-level': toast.level,
      }, toast.text);
    }

    /* ------------------------------------------------------------------ *
     * 路径 → 引用 chip（与宿主桌面端拖拽同一套判据）
     * ------------------------------------------------------------------ */

    function trimTrailing(text) {
      return String(text ?? '').replace(/[/\\]+$/, '');
    }

    function basenameOf(absolute) {
      const trimmed = trimTrailing(absolute);
      const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
      return at === -1 ? trimmed : trimmed.slice(at + 1);
    }

    /** 绝对路径 → 工作区相对路径；不在工作区内就保持绝对路径（宿主同样处理）。 */
    function relativize(absolute, cwd) {
      if (typeof cwd !== 'string' || cwd === '') return absolute;
      const root = trimTrailing(cwd);
      if (absolute === root) return '.';
      return absolute.startsWith(`${root}/`) || absolute.startsWith(`${root}\\`) ? absolute.slice(root.length + 1) : absolute;
    }

    /** 与宿主 `formatFileMention` 同形：空白路径用双引号包住整段。 */
    function formatMention(path) {
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
      return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
    }

    /**
     * 把宿主返回的 `{ path, isDirectory }` 整理成宿主 `addFiles` 认识的引用描述。
     * 目录以 `/` 结尾的 mention、appearance 为 folder；普通文件 appearance 为 file。
     * 路径里带控制字符或双引号时 `formatMention` 返回 undefined，直接跳过（与原宿主同判据）。
     */
    function buildReferenceEntries(entries, cwd) {
      const references = [];
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') continue;
        const absolute = trimTrailing(entry.path);
        if (absolute === '') continue;
        const isDirectory = entry.isDirectory === true;
        const relative = relativize(absolute, cwd);
        const mention = formatMention(isDirectory ? `${relative}/` : relative);
        if (mention === undefined) continue;
        const label = isDirectory ? `${basenameOf(absolute)}/` : basenameOf(absolute);
        references.push({
          source: 'reference',
          ref: mention,
          label,
          appearance: isDirectory ? 'folder' : 'file',
          clipboardText: mention,
        });
      }
      return references;
    }

    /* ------------------------------------------------------------------ *
     * 图标
     * ------------------------------------------------------------------ */

    function SparkleIcon(props) {
      const size = props !== null && typeof props === 'object' && typeof props.size === 'number' ? props.size : 16;
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M8 1.6l1.55 4.05L13.6 7.2 9.55 8.75 8 12.8 6.45 8.75 2.4 7.2 6.45 5.65 8 1.6z',
          fill: 'currentColor',
        }));
    }

    function FilesIcon(props) {
      const size = props !== null && typeof props === 'object' && typeof props.size === 'number' ? props.size : 16;
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M2.5 4.2c0-.6.4-1 1-1h3l1.2 1.4h4.8c.6 0 1 .4 1 1v6.2c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1V4.2z',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linejoin': 'round',
        }),
        h('path', { d: 'M6 8.6h4M6 10.6h2.6', stroke: 'currentColor', 'stroke-width': 1.1, 'stroke-linecap': 'round' }));
    }

    /* ================================================================== *
     * 样式（主题 token；没有硬编码颜色）
     *   原 dsh-markdown-composer 的规则原样保留；GenUI 按钮隐藏 / Toast 来自原 tweaks。
     * ================================================================== */

    const MARKDOWN_CSS = [
      /* 源码模式：隐藏宿主原生输入区，避免两个可编辑面同时存在 */
      `html[${SOURCE_ATTR}="true"] [data-input-scroll]{display:none!important}`,

      /* 开关行：贴在 composer 下方、与输入卡同宽居中，右对齐 */
      '.dmc-toggle-row{display:flex;justify-content:flex-end;box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,748px);margin:0 auto;padding:4px 12px 0}',
      '.dmc-toggle{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;user-select:none;transition:color .1s,background .1s}',
      '.dmc-toggle:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dmc-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dsw-focus-ring-color));outline-offset:1px}',
      '.dmc-toggle[aria-pressed="true"]{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}',
      '.dmc-toggle-glyph{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10px;letter-spacing:-.5px;opacity:.9}',

      /* 源码编辑面板 */
      '.dmc-source{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,748px);margin:0 auto 4px;padding:0 12px}',
      '.dmc-source-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.dmc-source-title{color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.dmc-source-hint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dmc-source-input{box-sizing:border-box;width:100%;min-height:118px;max-height:46vh;resize:vertical;margin:0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2,var(--dsw-specific-input-major,transparent));color:var(--dsw-alias-label-primary);font:400 12.5px/1.55 var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);outline:none;tab-size:2}',
      '.dmc-source-input:focus{border-color:var(--dsw-alias-border-l3,var(--dsw-alias-state-business-primary))}',
      '.dmc-source-input::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}',
      '.dmc-source-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.dmc-source-back{border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:11px;cursor:pointer;padding:0}',
      '.dmc-source-back:hover{text-decoration:underline}',

      /* 用户消息的 Markdown 渲染 */
      '.dmc-md{display:inline}',
      '.dmc-block{display:block}',
      '.dmc-p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dmc-p+.dmc-block{margin-top:.45em}',
      '.dmc-h{margin:0;font-weight:600;line-height:1.35}',
      '.dmc-h+.dmc-block{margin-top:.4em}',
      '.dmc-h1{font-size:1.25em}',
      '.dmc-h2{font-size:1.15em}',
      '.dmc-h3,.dmc-h4,.dmc-h5,.dmc-h6{font-size:1.05em}',
      '.dmc-quote{margin:0;padding-left:.6em;border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}',
      '.dmc-list{margin:0;padding:0}',
      '.dmc-li{display:flex;gap:.4em;align-items:baseline}',
      '.dmc-li-mark{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dmc-li-body{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dmc-pre-wrap{margin:0}',
      '.dmc-pre-lang{display:block;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;margin-bottom:2px}',
      '.dmc-pre{display:block;margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.5;white-space:pre;overflow-x:auto;tab-size:2}',
      '.dmc-inline-code{padding:0 4px;border-radius:4px;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2));font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.92em}',
      '.dmc-link{color:var(--dsw-alias-state-business-primary);text-decoration:underline;text-underline-offset:2px}',
      '.dmc-hr{height:.5px;margin:.5em 0;background:var(--dsw-alias-border-l2)}',
    ].join('\n');

    /* —— 原 dsh-composer-tweaks 的规则（GenUI 按钮隐藏 / Toast） —— */
    const TWEAKS_CSS = [
      `${GENUI_SELECTOR}{display:none!important}`,

      '.dmct-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2000;max-width:min(560px,80vw);padding:7px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-tooltip-bg,var(--dsw-alias-label-primary));color:var(--dsw-static-neutral-bluish-00,var(--dsw-alias-bg-layer-1));font:inherit;font-size:12px;line-height:18px;box-shadow:var(--dsw-elevation-panel,0 6px 20px rgba(0,0,0,.18));white-space:pre-line;overflow-wrap:anywhere;pointer-events:none}',
    ].join('\n');

    /* 合并进同一个 <style>：两组选择器互不重叠，顺序不影响匹配 */
    const CSS = `${TWEAKS_CSS}\n${MARKDOWN_CSS}`;

    /* ================================================================== *
     * 插件入口
     * ================================================================== */

    /* 合并后的字典：必须是扁平点号键（宿主 locale 服务只认扁平键，嵌套对象会取不到值）。
       两包 key 唯一的冲突是 meta.title / meta.description：合并插件用覆盖三件事的新文案，
       原 Markdown 包的文案改名到 markdown.meta.* 保留，不丢内容。 */
    const zh = {
      'meta.title': '输入框微调与 Markdown 输入',
      'meta.description': '隐藏 GenUI 输入框按钮、把文件/文件夹合并成一个混选入口，并在输入框下方加「源码 / 视图」开关、把聊天记录里的用户消息按 Markdown 渲染。',
      'markdown.meta.title': 'Markdown 输入开关',
      'markdown.meta.description': '在输入框下方加一颗「源码 / 视图」开关：源码模式用等宽编辑框写 Markdown，聊天记录里的用户消息按 Markdown 渲染。',
      'toggle.source': '源码',
      'toggle.view': '视图',
      'toggle.toSourceHint': '切换到 Markdown 源码模式（等宽编辑，⌘/Ctrl+Enter 发送）',
      'toggle.toViewHint': '切换到视图模式（宿主原生输入框）',
      'source.title': 'Markdown 源码',
      'source.hint': '实时写回输入框；@引用、/命令切成文本后仍可还原',
      'source.placeholder': '在这里写 Markdown 源码……',
      'source.sendHint': '⌘/Ctrl+Enter 发送',
      'source.back': '切回视图模式',
      'genui.labelOn': 'GenUI 提示词（开）',
      'genui.labelOff': 'GenUI 提示词（关）',
      'genui.descriptionOn': '已开启：助手回复用 GenUI 组件渲染；点击关闭。',
      'genui.descriptionOff': '已关闭：只渲染普通 Markdown；点击开启。',
      'genui.unknown': '读不到 GenUI 开关状态（GenUI 未加载或接口不可用）',
      'genui.failing': 'GenUI 开关操作失败：{message}',
      'pick.label': '选择文件或文件夹',
      'pick.description': '一次选中多个文件和文件夹，作为 @引用插入（不复制文件内容）',
      'pick.cancelled': '已取消选择',
      'pick.empty': '没有选中任何文件或文件夹',
      'pick.inserted': '已插入 {count} 项',
      'pick.failed': '选择失败：{message}',
      'pick.unavailable': '混合选择器不可用：宿主半没有加载（重开 DSH Desktop 后生效）',
      'pick.fallback': '无法生成引用，已改为插入文本路径',
    };

    const en = {
      'meta.title': 'Composer tweaks & Markdown',
      'meta.description': 'Hide the GenUI composer button, merge file/folder adding into one mixed picker, add a source/view switch, and render user messages as Markdown in the transcript.',
      'markdown.meta.title': 'Markdown input toggle',
      'markdown.meta.description': 'Adds a source/view switch under the composer: edit Markdown in a monospace editor and render user messages as Markdown in the transcript.',
      'toggle.source': 'Source',
      'toggle.view': 'View',
      'toggle.toSourceHint': 'Switch to Markdown source mode (monospace editor, Cmd/Ctrl+Enter sends)',
      'toggle.toViewHint': 'Switch to view mode (the native composer)',
      'source.title': 'Markdown source',
      'source.hint': 'Mirrors the draft live; @references and /commands are restored when switched back',
      'source.placeholder': 'Write Markdown source here…',
      'source.sendHint': 'Cmd/Ctrl+Enter sends',
      'source.back': 'Back to view mode',
      'genui.labelOn': 'GenUI prompt (on)',
      'genui.labelOff': 'GenUI prompt (off)',
      'genui.descriptionOn': 'On: replies render through GenUI components. Click to turn off.',
      'genui.descriptionOff': 'Off: plain Markdown only. Click to turn on.',
      'genui.unknown': 'GenUI prompt state is unavailable (GenUI not loaded or the route is down)',
      'genui.failing': 'GenUI toggle failed: {message}',
      'pick.label': 'Choose files or folders',
      'pick.description': 'Select several files and folders at once; inserted as @references (contents are not uploaded)',
      'pick.cancelled': 'Selection cancelled',
      'pick.empty': 'Nothing selected',
      'pick.inserted': 'Inserted {count} item(s)',
      'pick.failed': 'Picker failed: {message}',
      'pick.unavailable': 'Mixed picker unavailable: the Host half is not loaded (restart DSH Desktop)',
      'pick.fallback': 'Reference chips failed; inserted path text instead',
    };

    return {
      inject: ['slots', 'locale', 'commandUi'],
      apply(ctx) {
        const mode = createModeStore();

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`);
        const t = ctx.locale.bind(NS);
        const state = createGenuiState();
        const toast = createToastStore();
        let picking = false;

        ctx.effect(() => () => toast.dispose(), `${NS}: toast lifetime`);

        /* ---- GenUI 状态：首次读取 + 低频刷新 ---- */
        const refresh = () => {
          fetchGenuiState().then((next) => state.set(next)).catch((error) => {
            state.set({ enabled: false, available: false, error: error instanceof Error ? error.message : String(error) });
          });
        };
        ctx.effect(() => {
          refresh();
          const timer = window.setInterval(refresh, REFRESH_MS);
          return () => window.clearInterval(timer);
        }, `${NS}: genui state`);

        /* ---- 样式：隐藏 GenUI 按钮 + Toast ---- */
        ctx.effect(() => {
          let tag = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
          const created = tag === null;
          if (created) {
            tag = document.createElement('style');
            tag.dataset.plugin = '@jason25417/dsh-composer-tweaks';
            tag.dataset.pluginCss = STYLE_ID;
            tag.textContent = CSS;
            document.head.appendChild(tag);
          }
          return () => {
            if (created) tag.remove();
          };
        }, `${NS}: styles`);

        /* ---- 隐藏宿主内置的「文件」命令行：把 composer 的 filePicker 判为不可用 ---- */
        const hideCoreFileCommand = (sessionId) => {
          try {
            const conversation = ctx.get('conversation');
            const shell = conversation?.input?.shell?.(sessionId);
            if (shell === undefined || shell === null || typeof shell.bindFilePicker !== 'function') return () => {};
            const previous = shell.filePicker;
            const timer = window.setTimeout(() => {
              try {
                shell.bindFilePicker({ available: () => false, open() {} });
              } catch {
                /* 绑定失败只是「文件」行重新出现，不致命 */
              }
            }, 0);
            return () => {
              window.clearTimeout(timer);
              try {
                if (previous !== undefined) shell.bindFilePicker(previous);
                else shell.filePicker = undefined;
              } catch {
                /* 会话已销毁 */
              }
            };
          } catch {
            return () => {};
          }
        };

        /* ---- 混合选择：文件 + 文件夹一次选完 ---- */
        const pickAndInsert = async (sessionId) => {
          if (picking) return;
          picking = true;
          try {
            let response = null;
            let payload = null;
            try {
              response = await fetch(PICK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
              payload = await response.json().catch(() => null);
            } catch (error) {
              toast.publish('error', t('pick.failed', { message: error instanceof Error ? error.message : String(error) }));
              return;
            }
            if (payload === null) {
              // 宿主半没挂载时这里是 404/HTML：给能读懂的一句话，别甩 HTTP 原始错误
              const message = response !== null && response.status === 404
                ? t('pick.unavailable')
                : `HTTP ${response === null ? '?' : response.status}`;
              toast.publish('error', t('pick.failed', { message }));
              return;
            }
            if (payload.ok !== true) {
              const message = payload?.error?.message ?? t('pick.unavailable');
              toast.publish('error', t('pick.failed', { message }));
              return;
            }
            const entries = Array.isArray(payload.paths) ? payload.paths : [];
            if (entries.length === 0) {
              toast.publish('info', t('pick.cancelled'));
              return;
            }

            const conversation = ctx.get('conversation');
            const shell = conversation?.input?.shell?.(sessionId);
            if (shell === undefined || shell === null || typeof shell.addFiles !== 'function') {
              toast.publish('error', t('pick.unavailable'));
              return;
            }
            const cwd = ctx.get('sessions')?.list?.getSnapshot?.().byId?.[sessionId]?.cwd;
            const references = buildReferenceEntries(entries, cwd);
            if (references.length === 0) {
              toast.publish('error', t('pick.empty'));
              return;
            }
            let applied = false;
            try {
              applied = shell.addFiles(references, []) === true;
            } catch {
              applied = false;
            }
            if (!applied) {
              // 退路：把 @路径 作为文本插进草稿（宿主 setDraft 仍会解析回 chip）
              const mentions = references.map((entry) => entry.clipboardText).join(' ');
              try {
                shell.actions?.insertText?.(`${mentions} `, shell.actions.captureInsertion());
                toast.publish('info', t('pick.fallback'));
                return;
              } catch {
                toast.publish('error', t('pick.failed', { message: '插入失败' }));
                return;
              }
            }
            toast.publish('ok', t('pick.inserted', { count: references.length }));
          } finally {
            picking = false;
          }
        };

        /* ---- 加号菜单：GenUI 开关 ---- */
        ctx.effect(() => ctx.commandUi.register({
          name: 'genui-prompt',
          label: () => {
            const current = state.get();
            return current.enabled ? t('genui.labelOn') : t('genui.labelOff');
          },
          description: () => {
            const current = state.get();
            if (current.error !== null) {
              return current.available ? t('genui.failing', { message: current.error }) : t('genui.unknown');
            }
            return current.enabled ? t('genui.descriptionOn') : t('genui.descriptionOff');
          },
          icon: SparkleIcon,
          available: () => true,
          ui: {
            kind: 'action',
            run: () => {
              const current = state.get();
              const next = !current.enabled;
              writeGenuiState(next).then((result) => state.set(result)).catch((error) => {
                state.set({ enabled: current.enabled, available: current.available, error: error instanceof Error ? error.message : String(error) });
              });
            },
          },
        }), `${NS}: genui command`);

        /* ---- 加号菜单：合并后的文件/文件夹入口 ---- */
        ctx.effect(() => ctx.commandUi.register({
          name: 'files-and-folders',
          label: () => t('pick.label'),
          description: () => t('pick.description'),
          icon: FilesIcon,
          available: () => true,
          ui: {
            kind: 'action',
            run: (session) => {
              const sessionId = session?.sessionId;
              if (typeof sessionId !== 'string' || sessionId === '') {
                toast.publish('error', t('pick.unavailable'));
                return;
              }
              void pickAndInsert(sessionId);
            },
          },
        }), `${NS}: files command`);

        /* ---- 加号菜单：把「选择文件或文件夹」视觉上搬进「添加」分区 ----
           命令贡献本身无法指定分区（菜单分区由宿主固定名单决定），所以在菜单
           打开后用 DOM 克隆一行放进「添加」区、把原行隐藏；点击克隆行转发到
           原行的 mousedown（React 的选择逻辑挂在 mousedown 上）。
           菜单 DOM 由宿主管理，我们只加一个隐藏行 + 一个克隆行；菜单卸载时
           克隆随宿主 DOM 一起消失，不影响 React 的状态机。 */
        const decorateMenu = () => {
          try {
            const listbox = document.querySelector('[role="listbox"]');
            if (listbox === null) return true;
            const items = Array.from(listbox.querySelectorAll('button[role="option"]'));
            const original = items.find((button) => {
              const alias = button.querySelector('[class*="itemAlias"]');
              if (alias !== null && alias.textContent.trim() === 'files-and-folders') return true;
              return (button.textContent ?? '').includes('files-and-folders');
            });
            if (original === undefined) return true;
            if (original.dataset.cmtHidden === 'true') return true;
            const titles = Array.from(listbox.querySelectorAll('div[class*="sectionTitle"]'));
            const commandsTitle = titles.find((title) => /^(指令|Commands)$/.test((title.textContent ?? '').trim()));
            if (commandsTitle === undefined || commandsTitle.parentNode === null) return false;
            const clone = original.cloneNode(true);
            clone.removeAttribute('id');
            clone.removeAttribute('aria-selected');
            clone.dataset.cmtClone = 'true';
            clone.addEventListener('mousedown', (event) => {
              event.preventDefault();
              original.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            });
            commandsTitle.parentNode.insertBefore(clone, commandsTitle);
            original.style.display = 'none';
            original.dataset.cmtHidden = 'true';
            return true;
          } catch {
            return true;
          }
        };
        const waitAndDecorate = (attempt = 0) => {
          if (decorateMenu() || attempt > 120) return;
          window.requestAnimationFrame(() => waitAndDecorate(attempt + 1));
        };
        ctx.effect(() => {
          const onClick = (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const button = target.closest('button[aria-haspopup="listbox"]');
            if (button === null) return;
            window.setTimeout(() => waitAndDecorate(), 30);
          };
          document.addEventListener('click', onClick, true);
          return () => document.removeEventListener('click', onClick, true);
        }, `${NS}: plus-menu decoration`);

        /* ---- Toast 浮层（shell.overlay 是帧级浮层） ---- */
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'composer-tweaks-toast',
          order: 2000,
          inject: () => ({ toast }),
        }, ToastOverlay));

        /* ---- 每个会话挂载时：隐藏宿主「文件」行；同时作为插件活性探针 ---- */
        function SessionProbe(props) {
          const sessionId = props.sessionId;
          React.useEffect(() => {
            if (typeof sessionId !== 'string' || sessionId === '') return undefined;
            return hideCoreFileCommand(sessionId);
          }, [sessionId]);
          return null;
        }
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'composer-tweaks-probe',
          order: 999,
        }, SessionProbe));

        /* ---- 原 dsh-markdown-composer：输入框下方的「源码 / 视图」开关 ---- */
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'markdown-composer-toggle',
          order: 2,
          locale: NS,
          inject: () => ({ mode }),
        }, ModeToggle));

        /* ---- 原 dsh-markdown-composer：输入框上方的源码编辑面板 ---- */
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'markdown-composer-source',
          order: 70,
          locale: NS,
          inject: () => ({ mode }),
        }, SourcePanel));

        /* ---- 原 dsh-markdown-composer：聊天记录里的用户消息 → Markdown 渲染器 ---- */
        ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
          name: 'conversation.user.text.node',
          key: 'text',
          priority: 0,
        }, MarkdownUserText));
      },
    };
  },
});
