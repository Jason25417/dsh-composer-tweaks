/**
 * markdown.js 的单元测试（纯函数，不依赖宿主）。
 * 运行：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkdown, parseInline, isSafeHref } from '../markdown.js';

function types(nodes) {
  return nodes.map((node) => node.type);
}

test('段落与空行', () => {
  const blocks = parseMarkdown('第一段\n第二行\n\n第二段');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'paragraph');
  assert.deepEqual(blocks[0].children, [{ type: 'text', text: '第一段\n第二行' }]);
  assert.deepEqual(blocks[1].children, [{ type: 'text', text: '第二段' }]);
});

test('标题 1-6 级，尾部 # 可以省略', () => {
  const blocks = parseMarkdown('# 一级\n## 二级\n###### 六级\n####### 不是标题');
  assert.deepEqual(blocks.slice(0, 3).map((b) => [b.type, b.level]), [['heading', 1], ['heading', 2], ['heading', 6]]);
  assert.equal(blocks[3].type, 'paragraph');
  assert.equal(blocks[3].children[0].text, '####### 不是标题');
});

test('围栏代码块：带语言、原样保留内容、到文件尾也闭合', () => {
  const blocks = parseMarkdown('```js\nconst a = 1;\n  b();\n```\n\n```\nplain\n```');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].lang, 'js');
  assert.equal(blocks[0].text, 'const a = 1;\n  b();');
  assert.deepEqual(blocks[1], { type: 'code', lang: '', text: 'plain' });

  const unclosed = parseMarkdown('```bash\necho hi');
  assert.equal(unclosed[0].type, 'code');
  assert.equal(unclosed[0].text, 'echo hi');
});

test('波浪号围栏也认', () => {
  const blocks = parseMarkdown('~~~\nx\n~~~');
  assert.deepEqual(blocks, [{ type: 'code', lang: '', text: 'x' }]);
});

test('引用块合并连续 > 行', () => {
  const blocks = parseMarkdown('> 第一行\n> 第二行\n\n正文');
  assert.equal(blocks[0].type, 'quote');
  assert.deepEqual(blocks[0].children, [{ type: 'text', text: '第一行\n第二行' }]);
});

test('无序列表与有序列表', () => {
  const unordered = parseMarkdown('- a\n- b\n- c');
  assert.equal(unordered[0].type, 'list');
  assert.equal(unordered[0].ordered, false);
  assert.deepEqual(unordered[0].items.map((item) => item.children[0].text), ['a', 'b', 'c']);

  const ordered = parseMarkdown('1. 一\n2. 二');
  assert.equal(ordered[0].ordered, true);
  assert.equal(ordered[0].items.length, 2);
});

test('水平线', () => {
  assert.deepEqual(parseMarkdown('---'), [{ type: 'hr' }]);
  assert.deepEqual(parseMarkdown('* * *'), [{ type: 'hr' }]);
  // 单独一个 - 不是水平线，是列表项
  assert.equal(parseMarkdown('- 项目')[0].type, 'list');
});

test('行内：粗体、斜体、删除线、代码', () => {
  assert.deepEqual(parseInline('**粗**'), [{ type: 'strong', children: [{ type: 'text', text: '粗' }] }]);
  assert.deepEqual(parseInline('__粗__'), [{ type: 'strong', children: [{ type: 'text', text: '粗' }] }]);
  assert.deepEqual(parseInline('*斜*'), [{ type: 'em', children: [{ type: 'text', text: '斜' }] }]);
  assert.deepEqual(parseInline('~~删~~'), [{ type: 'del', children: [{ type: 'text', text: '删' }] }]);
  assert.deepEqual(parseInline('`code`'), [{ type: 'code', text: 'code' }]);
});

test('行内嵌套：粗体里的代码、链接里的粗体', () => {
  const strong = parseInline('**k**');
  assert.equal(strong[0].type, 'strong');

  const mixed = parseInline('**a `b` c**');
  assert.equal(mixed[0].type, 'strong');
  assert.deepEqual(types(mixed[0].children), ['text', 'code', 'text']);

  const link = parseInline('[**点我**](https://example.com)');
  assert.equal(link[0].type, 'link');
  assert.equal(link[0].href, 'https://example.com');
  assert.equal(link[0].children[0].type, 'strong');
});

test('链接：http(s)/mailto 放行，其它协议按文本', () => {
  assert.equal(isSafeHref('https://x'), true);
  assert.equal(isSafeHref('http://x'), true);
  assert.equal(isSafeHref('mailto:a@b.c'), true);
  assert.equal(isSafeHref('javascript:alert(1)'), false);
  assert.equal(isSafeHref('/relative'), false);

  const bad = parseInline('[x](javascript:alert(1))');
  assert.deepEqual(bad, [{ type: 'text', text: '[x](javascript:alert(1))' }]);
});

test('反斜杠转义', () => {
  assert.deepEqual(parseInline('\\*不是斜体\\*'), [{ type: 'text', text: '*不是斜体*' }]);
});

test('未闭合的标记按原文保留', () => {
  assert.deepEqual(parseInline('**没闭合'), [{ type: 'text', text: '**没闭合' }]);
  assert.deepEqual(parseInline('`没闭合'), [{ type: 'text', text: '`没闭合' }]);
  assert.deepEqual(parseInline('~~没闭合'), [{ type: 'text', text: '~~没闭合' }]);
});

test('数学式 2 * 3 * 4 不会被误判成斜体', () => {
  const nodes = parseInline('2 * 3 * 4');
  assert.deepEqual(types(nodes), ['text']);
  assert.equal(nodes[0].text, '2 * 3 * 4');
});

test('纯文本原样', () => {
  assert.deepEqual(parseMarkdown('你好，世界'), [{ type: 'paragraph', children: [{ type: 'text', text: '你好，世界' }] }]);
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('   \n\n'), []);
});

test('列表项里的行内 markdown', () => {
  const blocks = parseMarkdown('- **重点**：`code`');
  const item = blocks[0].items[0];
  assert.deepEqual(types(item.children), ['strong', 'text', 'code']);
});

test('混合文档结构完整', () => {
  const source = [
    '# 标题',
    '',
    '正文 **粗** 和 `code`',
    '',
    '```py',
    'print(1)',
    '```',
    '',
    '> 引用',
    '',
    '- 一',
    '- 二',
    '',
    '---',
    '',
    '结尾',
  ].join('\n');
  const blocks = parseMarkdown(source);
  assert.deepEqual(types(blocks), ['heading', 'paragraph', 'code', 'quote', 'list', 'hr', 'paragraph']);
});
