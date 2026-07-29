# Native desktop readiness

This is the implementation checklist for Tonearm's Tauri shell. It distinguishes
native operating-system integration from visual adaptation inside the system
WebView; the latter is still HTML/CSS, not AppKit or WinUI.

## Platform expectations

| Expected desktop behaviour | macOS | Windows | Implementation |
| --- | --- | --- | --- |
| OS-owned window controls | Meets | Meets | The real traffic lights and Windows caption buttons remain enabled. Windows keeps an opaque, decorated window; macOS uses an overlay titlebar. |
| Entire visible titlebar drags | Meets | OS titlebar | The 38px macOS strip explicitly calls Tauri's native `startDragging` API from its full hit area. Windows uses the standard caption. |
| Window size and position persist | Meets | Meets | The official Tauri window-state plugin restores geometry between launches. |
| Close/reopen follows platform convention | Meets | Meets | On macOS the red button hides the player, Dock reopen restores it, and Command-Q quits. Windows close exits normally. |
| Platform typography and control geometry | Meets | Meets | macOS uses the SF system stack and Mac-sized controls; Windows uses Segoe UI Variable, Fluent spacing, corner radii, focus rings and selection treatment. |
| Settings and update commands in expected location | Meets | Meets | macOS exposes Settings with Command-comma and Check for Updates in the application menu. Both platforms expose the same actions in Settings. |
| Browser installation copy absent in native build | Meets | Meets | Desktop downloads, PWA install instructions and deployment controls are hidden from the Tauri Connections page. |
| Text-editing shortcuts never control playback | Meets | Meets | Native Playback menu key equivalents were removed because AppKit consumes them before WebView focus checks. The configurable WebView shortcuts ignore inputs, selects, textareas and editable content. |
| Media keys and lock-screen metadata | Meets where the OS WebView supports Media Session | Meets where the OS WebView supports Media Session | Tonearm publishes track metadata, artwork, transport controls and position through the browser Media Session API. |
| In-app update check and install | Ready after updater key provisioning | Ready after updater key provisioning | The UI checks GitHub, shows version/progress, installs, verifies the mandatory Tauri signature and relaunches. |
| Command-line update | App UI preferred | App UI preferred | Linux AppImage users can run `tonearm --update` (or the AppImage path with `--update`). |
| Alternate icon colours | Dock-session icon | Running window/taskbar icon | The familiar Tonearm record mark is unchanged. Blue, purple, pink and original orange variants change only the colour. The signed bundle/Finder icon stays the default colour on macOS. |
| Signed distribution identity | Ad-hoc bundle signature | Not configured | The no-cost Tauri-recommended ad-hoc signature prevents malformed Apple Silicon bundles, but it is not Developer ID or notarisation. Windows Authenticode still needs external identity credentials. Tauri updater signatures are separate and mandatory on every platform. |

## Technical quality audit

| Dimension | Score | Finding |
| --- | ---: | --- |
| Accessibility | 4/4 | Semantic buttons, visible focus, live update status and Media Session support are present. The custom icon radiogroup uses one tab stop plus arrow, Home and End selection. |
| Performance | 4/4 | Desktop adaptations are CSS-scoped, updater code is small, settings remains route-split, and no polling runs beyond the one quiet launch check. |
| Responsive design | 3/4 | The desktop shell has a supported 840×600 minimum and the update notice adapts at narrow widths. Several desktop controls intentionally use compact mouse/keyboard targets rather than mobile 44px targets. |
| Theming | 4/4 | Platform rules preserve Tonearm's live theme tokens; desktop materials, controls and update UI respond to user palettes. |
| Anti-patterns | 4/4 | Album art remains the visual focus. Native adaptations are restrained and functional rather than decorative card/glow treatment. |
| **Total** | **19/20** | **Excellent — only external distribution identity remains.** |

Severity summary: no P0 issues, two P1 release-identity gaps (Apple Developer ID
and notarisation, plus Windows Authenticode), and no material P2 or P3 findings.

The release-identity gaps are intentionally separate from this code pass:
certificates require verified external identities. Windows builds remain
unsigned by the owner's earlier decision; flagged binaries should continue to
be submitted as false positives. The Tauri update signing key is not an identity
certificate—it protects the update channel from tampered packages and is
required before the updater can be enabled.

## Regression checks

- `bun run typecheck`
- `bun test src/lib/runtime.test.ts src/features/shell/shortcuts.test.ts`
- `bun run build`
- `cargo check --manifest-path src-tauri/Cargo.toml` on each supported Rust target
- A release smoke test on macOS, Windows 10, Windows 11 and an AppImage-capable
  Linux distribution before publishing
