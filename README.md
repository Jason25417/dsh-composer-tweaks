# dsh-composer-tweaks

[![test](https://github.com/Jason25417/dsh-composer-tweaks/actions/workflows/test.yml/badge.svg)](https://github.com/Jason25417/dsh-composer-tweaks/actions/workflows/test.yml) [![dsh](https://img.shields.io/badge/dsh-0.2.x-4b8dff)](https://github.com/deepseek-ai/deepseek-harness) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)


输入框（composer）与侧栏行的小调整。**0.2.0 起合并了原 `dsh-markdown-composer` 的全部功能**，
现在一个 bundle 同时覆盖「输入框微调」和「Markdown 输入/渲染」。

1. **隐藏 GenUI 的输入框小按钮**（`button[aria-label="GenUI prompt"]`）。
2. **把 GenUI 提示词开关放进左下角加号菜单**（command `genui-prompt`，菜单项实时显示开/关）。
3. **把「添加文件」与「添加文件夹」合并成一个入口**「文件或文件夹」（command `files-and-folders`）：
   点开后由 Host 半弹 macOS 原生 **NSOpenPanel**，可以**同时多选文件和文件夹**；
   选中的每一项按宿主桌面端拖拽同款语义插进输入框（`@引用` chip，文件夹 appearance=folder）。
4. **输入框下方加「源码 / 视图」小开关**（`conversation.composer.dock`，order 2）：
   源码模式在输入框上方铺一块等宽 textarea 写 Markdown，实时写回宿主草稿、⌘/Ctrl+Enter 发送；
   模式记忆在 localStorage（key 沿用 `dsh-markdown-composer.mode`，老用户设置不丢）。
5. **Sidebar 会话行「在新窗口打开」**（0.2.1 起接管）：把宿主「置顶」按钮换成开窗按钮，
   点击调 `@local/dsh-popout-window` 的 `POST /popout/open`；置顶动作仍在右键菜单里。
   （原 `@jason25417/dsh-pin-popout` 在 0.2.2 启动时激活失败会拖垮 web boot，已停用。）
6. **聊天记录里的用户消息按 Markdown 渲染**（`conversation.user.text.node` 的 `text` 键、
   priority 0 替换宿主纯文本渲染器；助手消息宿主本来就会渲染）。

## 合并说明（0.2.0）

- 功能来源：`dsh-markdown-composer`（旧目录标记为 legacy，见其 `MIGRATED.md`，**不要单独安装**）。
- 解析器唯一源在 `markdown.js`；`client.js` 内嵌一份**逐字副本**（浏览器模块不能相对 import），
  `tests/client-structure.test.mjs` 会逐字核对。
- 合并后的 `inject` 是 `['slots', 'locale', 'commandUi']`。
- 合并后的 locale 字典是**一份扁平点号键**（宿主 locale 服务只认扁平键）：原 `toggle.*` /
  `source.*` / `genui.*` / `pick.*` 全部保留；两包唯一冲突的 `meta.title` / `meta.description`
  用合并后的新文案，原 Markdown 包的文案改名到 `markdown.meta.*` 保留。
- 兼容常量不变：localStorage key `dsh-markdown-composer.mode`、源码模式 CSS 属性
  `data-dsh-markdown-source`、三个槽位的 name / id / key / priority / order。

## 源码 / 视图模式怎么同步

- 打开源码模式时从 `useInput(state => state.draft)` 取宿主草稿（chip 的文本投影）灌进 textarea；
- 每次输入 `inputActions.setDraft(value)` 实时写回宿主草稿，所以点宿主自己的发送键就能发；
- ⌘/Ctrl+Enter 直接发送（`inputActions.submit()`）；
- 切回视图模式时草稿已经在宿主里；宿主 `setDraft` 会走 `resolveDraftInput`，把 `@路径` /
  `/命令` 重新解析成 chip，所以来回切换不会丢引用（依赖宿主这层解析，属于宿主行为）；
- 源码模式下用一条 CSS 把宿主原生输入区（`[data-input-scroll]`）隐藏，避免两个可编辑面打架。

### 为什么没有「所见即所得」

DSH 的 composer 是 Lexical 纯文本编辑器（只有 chip / 引用这类装饰节点，没有 Markdown 富文本渲染层）。
浏览器里拿不到宿主的 Markdown 渲染器（插件不能 import `@deepseek-ai/*`），所以：

- 「视图模式」= 宿主原生输入框（所见即所输）；
- 「源码模式」= 等宽源码面板；
- **编译后的 Markdown 在发送后的聊天记录里**（用户消息由本插件渲染）。

## 为什么需要 Host 半

浏览器没有任何 API 能一次混选文件和文件夹：`<input type=file>` 只收文件，
`webkitdirectory` 只收目录，File System Access 也分两个入口。唯一能做混选的是
AppKit 的 `NSOpenPanel`（`canChooseFiles` + `canChooseDirectories` +
`allowsMultipleSelection`），只能在宿主进程里调。Host 半沿用 DSH 自带目录选择器
同一条 macOS 方案：`osascript -l JavaScript` 调 NSOpenPanel（同款 Edit 菜单，
保证面板里的路径输入框可 ⌘C/⌘V）。

- 路由：`POST /api/dsh-composer/pick`（挂 `connection.fetch`，宿主鉴权通道，只服务同源 GUI 客户端）。
- 回包：`{ ok: true, paths: [{ path, isDirectory }] }`；取消时 `paths: []`；
  非 macOS 回 `501 { ok:false, error:{ code:'unsupported-platform' } }`；失败回 500 + 人读 message。

## 合并后菜单里剩什么

- 加号 →「指令」区：「GenUI 提示词（开/关）」、「文件或文件夹」两个条目。
- 宿主内置的「文件」行被隐藏：本插件把 composer 的 `filePicker` 判为不可用
  （在 composer.dock 的探针组件里，于会话挂载/切换时执行）。
- `dsh-folder-attach` 的「添加文件夹」行已从该插件源码里移除。
- 若隐藏失败（宿主改实现），最坏情况是「文件」行重新出现——两个入口都在，不丢能力。

## 插入语义（和桌面端拖拽一致）

- 文件夹 → `@相对路径/` 引用 chip（appearance=folder）。
- 普通文件 → `@相对路径` 引用 chip（appearance=file）。
- 路径不在当前工作区时保留绝对路径（宿主同样这么处理）。
- 带空白的路径用 `@"…"` 包住；含控制字符或双引号的路径跳过（宿主同判据）。
- **注意**：这是「引用」而不是「上传」——文件内容不进消息体，行内提到的是路径。
  桌面端拖拽普通文件本来也是引用；只有图片会走上传预览。混合选择器不做上传。
- 插入失败时退路：把 `@路径` 文本插进草稿（宿主 `setDraft` 会再解析回 chip）。

## 回执

command 的 action 没有 Toast 通道，本插件自带一个帧级 Toast（`shell.overlay`）：
「已插入 N 项 / 已取消选择 / 选择失败：…」。宿主半没加载时提示「重开 DSH Desktop 后生效」。

## 安装 / 卸载

市场/插件页安装后**完全退出重开一次 DSH Desktop**；CLI：

```sh
dsh plugin --profile <profile> add @jason25417/dsh-composer-tweaks
```

（npm 可选；也可以从 release tarball 或源码 link 安装。）本机当前用 link 安装在 desktop profile。

**Host 半路由要完全退出并重开 DSH Desktop 才生效**（Host 插件只在启动时挂载；
Client 半会热加载）。重开前点菜单里的「文件或文件夹」会提示宿主半未加载。

```bash
# 卸载
# plugin_manager remove_bundle target=@local/dsh-composer-tweaks
```

注意：旧 `dsh-markdown-composer` 的 bundle 已在 2026-11-05 从本机 desktop profile 移除，源码目录保留为 legacy；其它 profile 若仍有它，重启后会与本插件
重复注册同一批槽位（用户消息渲染器两个、开关两个）。迁移完成并从 profile 移除旧包后即可
（本轮只改源码，未动 profile）。

## 测试

```bash
node --test tests/*.test.mjs
```

36 项全绿：

- `tests/client.test.mjs`（6 项）：样式隐藏规则、两个命令注册、GenUI 状态读写、
  混合选择 → file/folder 引用 → `shell.addFiles`、取消/失败/空选择不插入、探针注册。
- `tests/client-structure.test.mjs`（7 项）：内嵌解析器与 `markdown.js` 逐字一致、
  合并后三个 Markdown 槽位 + 原 tweaks 注册都在、locale 扁平键/键集合/冲突改名、
  合并样式无硬编码颜色、源码模式 CSS 与兼容常量不变、用户消息 Markdown 渲染、
  模式记忆（localStorage key 与 source 恢复）。
- `tests/markdown.test.mjs`（16 项）：解析器（标题/代码块/引用/列表/行内强调/链接安全/
  转义/不误判）。
- `tests/picker.test.mjs`（7 项）：面板脚本三要素、stdout 解析（取消/字符串/对象/坏输出）、
  非 darwin 明确失败、osascript argv 形状、路由回包信封、`apply` 注册路由。

## 已知边界

- 只在 macOS 实现混选（Windows/Linux 明确回 501，不假装成功）。
- 面板是宿主进程弹的，出现在 DSH 窗口之上但不抢焦点；若 macOS 拒绝前置，
  面板可能落在别的 Space（与 DSH 自带目录选择器同一限制）。
- 隐藏宿主「文件」行依赖 composer 的 `filePicker` 与 `bindFilePicker` 接口；
  宿主改实现时该行会重新出现（能力不受影响）。
- GenUI 隐藏依赖固定 `aria-label="GenUI prompt"`。
- Markdown 是子集（标题、围栏代码、引用、单层列表、水平线、段落；行内 code/粗/斜/删/链接）。
  原始 HTML 一律按文本显示（防 XSS）；表格、嵌套列表不解析，按原文显示。
- 源码面板隐藏宿主输入区用的是 `[data-input-scroll]` 选择器 + 我们加的
  `html[data-dsh-markdown-source]` 属性；宿主若改这个 data 属性，源码模式会退化成
  「面板和原生输入框同时显示」，不会坏数据。
- 用户消息渲染器是全局替换 `text` 键：所有会话的用户消息都会按 Markdown 渲染。
