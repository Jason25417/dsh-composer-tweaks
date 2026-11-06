/**
 * composer-tweaks 的 Host 半测试（不依赖宿主）：
 *   · NSOpenPanel 脚本含混选三要素（canChooseFiles / canChooseDirectories / allowsMultipleSelection）；
 *   · stdout 解析：取消 → null；JSON 数组 → [{path,isDirectory}]；
 *   · 平台/执行器注入：非 darwin 明确报 unsupported-platform；执行失败向上抛；
 *   · apply() 在 connection.fetch 上注册路由，且路由回包是 { ok, paths } / { ok:false, error }。
 *
 * 运行：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PICK_ROUTE,
  ORIGIN_ROUTE,
  PICK_TITLE,
  MAC_PANEL_SCRIPT,
  parsePanelOutput,
  pickPaths,
  createPickHandler,
  apply,
} from '../index.js';

test('面板脚本：混选三要素 + Edit 菜单 + message 标题', () => {
  assert.match(MAC_PANEL_SCRIPT, /canChooseFiles = true/);
  assert.match(MAC_PANEL_SCRIPT, /canChooseDirectories = true/);
  assert.match(MAC_PANEL_SCRIPT, /allowsMultipleSelection = true/);
  assert.match(MAC_PANEL_SCRIPT, /addItemWithTitleActionKeyEquivalent\('Paste', 'paste:', 'v'\)/);
  assert.match(MAC_PANEL_SCRIPT, /panel\.message = argv\[0\]/);
  assert.match(MAC_PANEL_SCRIPT, /JSON\.stringify\(paths\)/);
  assert.equal(PICK_TITLE.length > 0, true);
});

test('parsePanelOutput：取消 / 字符串数组 / 对象数组 / 坏输出', () => {
  assert.equal(parsePanelOutput(''), null);
  assert.equal(parsePanelOutput('\n'), null);

  assert.deepEqual(parsePanelOutput('["/a/b","/a/c/"]'), [
    { path: '/a/b', isDirectory: false },
    { path: '/a/c/', isDirectory: true },
  ]);

  assert.deepEqual(parsePanelOutput('[{"path":"/a","isDirectory":true},{"path":"/b","isDirectory":false},{"path":""}]'), [
    { path: '/a', isDirectory: true },
    { path: '/b', isDirectory: false },
  ]);

  assert.throws(() => parsePanelOutput('not json'), /无法解析/);
  assert.throws(() => parsePanelOutput('{"a":1}'), /不是数组/);
});

test('pickPaths：非 darwin 明确失败，不假装成功', async () => {
  await assert.rejects(
    () => pickPaths({ platform: 'linux' }),
    (error) => {
      assert.equal(error.code, 'unsupported-platform');
      assert.match(error.message, /macOS/);
      return true;
    },
  );
});

test('pickPaths：把标题作为 argv 传给 osascript，解析 stdout', async () => {
  const seen = [];
  const paths = await pickPaths({
    platform: 'darwin',
    run: async (args) => {
      seen.push(args);
      return '[{"path":"/tmp/x","isDirectory":false}]';
    },
  });
  assert.deepEqual(paths, [{ path: '/tmp/x', isDirectory: false }]);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].slice(0, 2), ['-l', 'JavaScript']);
  assert.equal(seen[0][2], '-e');
  assert.equal(seen[0][3], MAC_PANEL_SCRIPT);
  assert.equal(seen[0][4], PICK_TITLE);
});

test('pickPaths：执行器抛错时向上传递', async () => {
  await assert.rejects(
    () => pickPaths({ platform: 'darwin', run: async () => { throw new Error('osascript missing'); } }),
    /osascript missing/,
  );
});

test('createPickHandler：成功 / 取消 / 失败三种回包（不弹真面板）', async () => {
  const ok = createPickHandler(async () => [{ path: '/tmp/a', isDirectory: false }]);
  const okBody = await (await ok(new Request(`http://localhost${PICK_ROUTE}`, { method: 'POST', body: '{}' }))).json();
  assert.deepEqual(okBody, { ok: true, paths: [{ path: '/tmp/a', isDirectory: false }] });

  const cancelled = createPickHandler(async () => null);
  const cancelledBody = await (await cancelled(new Request(`http://localhost${PICK_ROUTE}`, { method: 'POST', body: '{}' }))).json();
  assert.deepEqual(cancelledBody, { ok: true, paths: [] });

  const failed = createPickHandler(async () => {
    throw Object.assign(new Error('no panel'), { code: 'unsupported-platform' });
  });
  const failedResponse = await failed(new Request(`http://localhost${PICK_ROUTE}`, { method: 'POST', body: '{}' }));
  assert.equal(failedResponse.status, 501);
  const failedBody = await failedResponse.json();
  assert.equal(failedBody.ok, false);
  assert.equal(failedBody.error.code, 'unsupported-platform');
  assert.equal(failedBody.error.message, 'no panel');
});

test('apply：在 connection.fetch 上注册 POST 路由', () => {
  const routes = [];
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['connection']);
      callback({
        connection: {
          fetch: {
            register(route) {
              routes.push(route);
              return () => {};
            },
          },
        },
        effect(fn) {
          fn();
        },
      });
    },
    effect(fn) {
      fn();
    },
  };
  apply(ctx);
  assert.equal(routes.length, 2);
  const pickRoute = routes.find((route) => route.path === PICK_ROUTE);
  const originRoute = routes.find((route) => route.path === ORIGIN_ROUTE);
  assert.ok(pickRoute, '缺少选择器路由');
  assert.deepEqual(pickRoute.methods, ['POST']);
  assert.equal(typeof pickRoute.fetch, 'function');
  assert.ok(originRoute, '缺少 Session 来源路由');
  assert.deepEqual(originRoute.methods, ['GET']);
});

test('readOrigins：解析标记文件（坏行忽略，同 id 取最后一条）', async () => {
  const { readOrigins } = await import('../index.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-test-'));
  const file = path.join(dir, 'session-origin.ndjson');
  fs.writeFileSync(file, [
    JSON.stringify({ sessionId: 's1', origin: 'external-bridge', at: 't1' }),
    'not json',
    JSON.stringify({ sessionId: 's2', origin: 'session-bridge' }),
    JSON.stringify({ sessionId: 's1', origin: 'external-bridge', at: 't2' }),
  ].join('\n'));
  const items = readOrigins(file);
  assert.equal(items.length, 2);
  const s1 = items.find((item) => item.sessionId === 's1');
  assert.equal(s1.at, 't2');
  assert.deepEqual(readOrigins(path.join(dir, 'missing.ndjson')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createOriginHandler：读取函数注入', async () => {
  const { createOriginHandler } = await import('../index.js');
  const handler = createOriginHandler(() => [{ sessionId: 's1', origin: 'external-bridge' }]);
  const body = await (await handler(new Request(`http://localhost${ORIGIN_ROUTE}`))).json();
  assert.deepEqual(body, { ok: true, items: [{ sessionId: 's1', origin: 'external-bridge' }] });
});
