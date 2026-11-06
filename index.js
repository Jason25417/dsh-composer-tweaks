/**
 * dsh-composer-tweaks — Host 半。
 *
 * 提供一条本机路由 `POST /api/dsh-composer/pick`：弹出 macOS 原生 NSOpenPanel，
 * 允许**同时多选文件和文件夹**，返回所选绝对路径。Client 半（加号菜单里的
 * 「文件或文件夹」条目）用这条路由把结果插进输入框。
 *
 * 为什么需要 Host 半：浏览器里没有任何 API 能一次性混选文件和文件夹
 * （`<input type=file>` 只收文件，`webkitdirectory` 只收目录，File System Access
 * 也分两个入口）。唯一能做混选的是 AppKit 的 NSOpenPanel（canChooseFiles +
 * canChooseDirectories + allowsMultipleSelection），而它只能在宿主进程里调。
 * 这里沿用 DSH 自带目录选择器同一条 macOS 方案：`osascript -l JavaScript` 调
 * NSOpenPanel（同款 Edit 菜单，保证面板里的文本框能 ⌘C/⌘V/⌘A）。
 *
 * 安全与边界：
 *   · 路由挂在 `connection.fetch` 上（宿主鉴权通道），只有同源 GUI 客户端能调；
 *   · 只在 macOS 实现，其它平台明确报 `unsupported-platform`，不假装成功；
 *   · 取消（用户按 Cancel）返回 `paths: []`，不是错误；
 *   · osascript 有硬超时（10 分钟），超时/失败回 `{ ok:false, error }`。
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PICK_ROUTE = '/api/dsh-composer/pick';
/** 读取「哪些 Session 是 agent/外部程序创建的」标记（同源 GUI 可调）。 */
export const ORIGIN_ROUTE = '/api/dsh-session-origin/list';
/** 与两个 bridge 插件共用同一个标记文件；追加写，读取时忽略坏行。 */
export const ORIGIN_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'session-origin.ndjson');
export const PICK_TIMEOUT_MS = 10 * 60 * 1000;

/** 面板标题（也作为 NSOpenPanel 的 message 显示）。 */
export const PICK_TITLE = '选择文件或文件夹（可多选）';

/**
 * NSOpenPanel 的 JXA 源码。照抄 DSH 自带目录选择器的写法：
 * 先装一个最小 Edit 菜单（否则面板里的路径输入框不能粘贴），再开面板。
 * canChooseFiles + canChooseDirectories + allowsMultipleSelection 三者同时为真
 * 就是「一个访达窗口里混选」的关键。
 */
export const MAC_PANEL_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var mainMenu = $.NSMenu.alloc.init;
  mainMenu.addItem($.NSMenuItem.alloc.init);
  var editMenu = $.NSMenu.alloc.initWithTitle('Edit');
  var editItem = $.NSMenuItem.alloc.init;
  editItem.submenu = editMenu;
  mainMenu.addItem(editItem);
  editMenu.addItemWithTitleActionKeyEquivalent('Undo', 'undo:', 'z');
  editMenu.addItemWithTitleActionKeyEquivalent('Redo', 'redo:', 'Z');
  editMenu.addItemWithTitleActionKeyEquivalent('Cut', 'cut:', 'x');
  editMenu.addItemWithTitleActionKeyEquivalent('Copy', 'copy:', 'c');
  editMenu.addItemWithTitleActionKeyEquivalent('Paste', 'paste:', 'v');
  editMenu.addItemWithTitleActionKeyEquivalent('Select All', 'selectAll:', 'a');
  app.mainMenu = mainMenu;
  var panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = true;
  panel.canChooseDirectories = true;
  panel.allowsMultipleSelection = true;
  panel.canCreateDirectories = false;
  panel.message = argv[0];
  $.NSOperationQueue.mainQueue.addOperationWithBlock(function() {
    app.activateIgnoringOtherApps(true);
  });
  if (panel.runModal !== $.NSModalResponseOK) return '';
  var urls = panel.URLs;
  var count = urls.count;
  var paths = [];
  for (var i = 0; i < count; i++) {
    var url = urls.objectAtIndex(i);
    paths.push({ path: ObjC.unwrap(url.path), isDirectory: Boolean(ObjC.unwrap(url.hasDirectoryPath)) });
  }
  return JSON.stringify(paths);
}`;

/** 失败信封（与其它插件路由同口径）。 */
export function failure(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * 解析 osascript 的 stdout：取消 → null；否则是 JSON 路径数组。
 * @throws 输出不是合法 JSON 数组时抛错（说明脚本/系统异常，不能当成取消）
 */
export function parsePanelOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (text === '') return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`原生选择器返回了无法解析的输出：${text.slice(0, 200)}`);
  }
  if (!Array.isArray(value)) throw new Error('原生选择器返回的不是数组');
  const entries = [];
  for (const item of value) {
    if (typeof item === 'string' && item !== '') {
      entries.push({ path: item, isDirectory: item.endsWith('/') });
      continue;
    }
    if (item !== null && typeof item === 'object' && typeof item.path === 'string' && item.path !== '') {
      entries.push({ path: item.path, isDirectory: item.isDirectory === true });
    }
  }
  return entries;
}

/** 默认 osascript 执行器：失败抛错，超时抛错。 */
function runOsascript(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('osascript', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) {
        if (error.killed === true || error.signal !== null) {
          reject(Object.assign(new Error(`原生选择器超时（${Math.round(timeoutMs / 1000)}s）`), { code: 'picker-timeout' }));
          return;
        }
        reject(Object.assign(new Error(`无法打开原生选择器：${error.message}`), { code: 'picker-failed' }));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * 打开混合选择器。
 * @param options.timeoutMs - 硬超时
 * @param options.platform - 平台（测试注入）
 * @param options.run - 执行器 `(args) => stdout`（测试注入）
 * @returns 选中的绝对路径数组；用户取消返回 null
 */
export async function pickPaths(options = {}) {
  const platform = options.platform ?? process.platform;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : PICK_TIMEOUT_MS;
  const run = typeof options.run === 'function'
    ? options.run
    : (args) => runOsascript(args, timeoutMs);
  if (platform !== 'darwin') {
    throw Object.assign(new Error('混合选择文件和文件夹目前只支持 macOS（需要 AppKit NSOpenPanel）'), { code: 'unsupported-platform' });
  }
  const stdout = await run(['-l', 'JavaScript', '-e', MAC_PANEL_SCRIPT, PICK_TITLE]);
  return parsePanelOutput(stdout);
}

/**
 * 读取 Session 来源标记：每行一个 `{ sessionId, origin, at }`；坏行忽略。
 * @param file - 标记文件路径（测试注入用）
 * @returns 去重后的标记数组（同一 session 取最后一条）
 */
export function readOrigins(file = ORIGIN_FILE) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const record = JSON.parse(trimmed);
      if (record !== null && typeof record === 'object' && typeof record.sessionId === 'string' && record.sessionId !== '') {
        byId.set(record.sessionId, {
          sessionId: record.sessionId,
          origin: typeof record.origin === 'string' && record.origin !== '' ? record.origin : 'agent',
          ...(typeof record.at === 'string' ? { at: record.at } : {}),
        });
      }
    } catch {
      /* 坏行忽略 */
    }
  }
  return [...byId.values()];
}

/**
 * 生成来源标记路由处理器（读取函数可注入，测试用）。
 * @param read - 返回标记数组的实现，默认 readOrigins
 * @returns `(request) => Promise<Response>`，回 `{ ok:true, items }`
 */
export function createOriginHandler(read = readOrigins) {
  return async function handleOrigins(_request) {
    try {
      return Response.json({ ok: true, items: read() });
    } catch (error) {
      return Response.json(failure('origin-read-failed', error instanceof Error ? error.message : String(error)), { status: 500 });
    }
  };
}

/**
 * 生成路由处理器（选择器可注入，测试用假实现，生产用真实 osascript）。
 * @param pick - 打开选择器的实现，默认 `pickPaths`
 * @returns `(request) => Promise<Response>`，回 `{ ok, paths }` 或失败信封
 */
export function createPickHandler(pick = pickPaths) {
  return async function handlePick(_request) {
    try {
      const paths = await pick();
      return Response.json({ ok: true, paths: paths ?? [] });
    } catch (error) {
      const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'pick-failed';
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`dsh-composer-tweaks: 混合选择器失败（${code}）：${message}`);
      return Response.json(failure(code, message), { status: code === 'unsupported-platform' ? 501 : 500 });
    }
  };
}

export function apply(ctx) {
  // 没有 connection（headless / tui）就整体不挂：这条路由只服务 GUI 客户端。
  ctx.inject(['connection'], (connCtx) => {
    const connection = connCtx.connection;
    if (connection === undefined || connection === null || connection.fetch === undefined) {
      console.warn('dsh-composer-tweaks: connection.fetch 不可用，混合选择器路由没有挂载');
      return;
    }
    connCtx.effect(() => connection.fetch.register({
      path: PICK_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createPickHandler(),
    }), 'composer-tweaks: mixed file/folder picker route');
    connCtx.effect(() => connection.fetch.register({
      path: ORIGIN_ROUTE,
      methods: ['GET'],
      requestBody: 'none',
      fetch: createOriginHandler(),
    }), 'composer-tweaks: session origin route');
  });
}
