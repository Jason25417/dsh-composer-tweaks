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
export function parseInline(source) {
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
export function isSafeHref(href) {
  return /^(https?:\/\/|mailto:)/i.test(String(href ?? '').trim());
}

/**
 * 块级解析。
 * @returns {Array<{type:string,...}>} 按出现顺序的块；每种块形如
 *   heading {level, children} / code {lang, text} / quote {children} /
 *   list {ordered, items: Array<{children}>} / hr / paragraph {children}
 */
export function parseMarkdown(source) {
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
