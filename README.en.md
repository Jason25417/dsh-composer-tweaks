
# dsh-composer-tweaks

Input-box (composer) tweaks for DeepSeek Harness (DSH): write Markdown in the composer, have your own messages render as Markdown, and add files and folders through one picker.

## What you get

- **Markdown source / view toggle** — a pill under the composer switches between the shipped editor and a monospace Markdown source panel. The chosen mode is remembered in `localStorage` (`dsh-markdown-composer.mode`). In source mode every keystroke is written to the host draft through `inputActions.setDraft`, so the host's own Send button still works, and ⌘/Ctrl+Enter submits directly. Switching back re-resolves `@path` / `/command` references through the host's `resolveDraftInput`, so chips survive a round trip. While the panel is open the native input area is hidden with CSS so there are never two editable surfaces fighting over focus.
- **Markdown rendering for user messages** — assistant messages are rendered by the harness already; this replaces the plain-text renderer for **user** messages through the `conversation.user.text.node` slot (`text` key, priority 0, the slot's documented `shadows-shipped-ui` replacement). A deliberately small subset: headings, fenced code, block quotes, single-level lists, horizontal rules and paragraphs, plus inline code / bold / italic / strikethrough / links. Raw HTML is shown as text, never executed.
- **One mixed file-and-folder picker** — the plus menu gets a single “Files or folders” row. The host half opens the macOS `NSOpenPanel` with `canChooseFiles`, `canChooseDirectories` and `allowsMultipleSelection` all on, so files and folders are multi-selected in one Finder window. The browser has no API that can do this (`<input type=file>` takes files only, `webkitdirectory` takes directories only, the File System Access API splits the two entries), which is why this half runs in the host process.
- **Sidebar row “open in new window”** (0.2.1) — replaces the shipped pin hover button with a popout button that calls the popout plugin's `POST /popout/open`; the pin action stays in the row context menu. The old `@jason25417/dsh-pin-popout` client failed to activate on 0.2.2 and could abort web boot, so it is no longer loaded.
- **GenUI prompt switch in the plus menu** — the shipped small GenUI button is hidden and a `genui-prompt` command row is registered in its place; the row shows the current on/off state.

Both command rows report their result through a frame-level Toast (`shell.overlay`): “inserted N items”, “cancelled”, or the failure reason. A cancelled panel is not an error.

## Requirements

- DSH `>= 0.2.1-rc.0 < 0.3.0` (verified on 0.2.2-rc.1; the host half mounts at app startup).
- macOS for the mixed picker. Windows and Linux are supported by the rest of the plugin, but the picker returns `501 unsupported-platform` explicitly rather than pretending to work.
- The web client (`dsh.client.platform: web`).

## Install

- **Plugins page / market:** install the bundle, then fully quit and reopen DSH Desktop once. The client half hot-loads, but a new plugin id is only picked up after a restart; the host half mounts only at startup.
- **CLI (web profile):**
  ```sh
  dsh plugin --profile <profile> add @jason25417/dsh-composer-tweaks
  ```
  (after the optional npm publish; until then install from the release tarball or from source)
- **From source:** add this directory as a bundle with the harness's plugin manager.

## How it works

**Host half — `POST /api/dsh-composer/pick`** *(exists today)*

The route is registered on `connection.fetch`, the host's authenticated channel, so only the same-origin GUI can call it. It runs the panel through `osascript -l JavaScript`, following the same macOS approach as the harness's own directory picker (a minimal Edit menu is installed so the panel's path field supports ⌘C/⌘V). The reply is:

- `{ ok: true, paths: [{ path, isDirectory }] }` on success;
- `{ ok: true, paths: [] }` when the user cancels (cancelling is not an error);
- `501 { ok: false, error: { code: 'unsupported-platform' } }` off macOS;
- `500 { ok: false, error }` with a human-readable message on failure. The panel call has a hard 10-minute timeout.

**Insertion semantics — same as a desktop drag.** A folder becomes an `@relative/path/` reference chip with `appearance=folder`; a file becomes an `@relative/path` chip. Paths outside the current workspace keep their absolute form; paths containing whitespace are wrapped as `@"…"`; paths containing control characters or double quotes are skipped (same rule as the host). If inserting the chips fails, the plugin falls back to writing `@path` text into the draft, which the host re-resolves into chips.

A reference is **not** an upload: file contents are not inlined into the message, the path is referenced. Only images take the upload-and-preview path in DSH, and the mixed picker does not upload.

**Shipped rows it hides.** The composer's own `filePicker` availability is turned off (from the `conversation.composer.dock` probe, re-applied on session mount/switch) so the built-in single-kind “File” row does not compete with the merged entry. If a DSH release changes that interface the built-in row can reappear — both entries still work, nothing is lost.

## Testing

```sh
node --test tests/*.test.mjs
```

Current source: **13** tests (client + picker/host), no network and no real panel — the `osascript` stdout parser, the cancel/empty/failure envelopes, route registration and the chip insertion path run against fakes. After the merge these suites are extended with the Markdown parser and client-structure tests; the total is recorded in the release checklist.

## Known limitations

- The mixed picker is macOS-only by design; other platforms get an explicit `501`, never a silent no-op.
- The panel belongs to the host process. It opens above the DSH window but does not steal focus; if macOS refuses the activation it can land on another Space — the same limitation as the harness's own directory picker.
- Hiding the shipped “File” row depends on the composer's `filePicker` / `bindFilePicker` interface, and hiding the GenUI button depends on `aria-label="GenUI prompt"`. If either changes in DSH, that row/button comes back; the capability is unaffected.
- Markdown is a subset (see above). Tables, nested lists and raw HTML are shown as plain text by design.
- The user-message renderer replaces the `text` key globally, so **all** sessions render user messages as Markdown once the plugin is on — this is a replacement of shipped UI, not a per-session option.
- Source mode hides the native input via the `[data-input-scroll]` selector plus an `html[data-dsh-markdown-source]` attribute. If the host changes that data attribute, the failure mode is both surfaces visible at once — no data is lost.

## Verification

Verified on DSH Desktop 0.2.2-rc.1 (macOS): the mixed picker returns files and folders selected in one panel, chips render correctly, and cancelling shows the Toast instead of an error; the Markdown tests and the source/view round trip are filled in by the merge and recorded in the release checklist before the public release.
