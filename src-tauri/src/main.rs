#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            use tauri::Manager;

            // Use the compositor effects users expect on each desktop instead
            // of imitating them in CSS. These are deliberately best-effort: the
            // result is discarded so an unsupported compositor leaves the window
            // opaque instead of aborting setup. Mica in particular is only
            // available from Windows 11 build 22000, and propagating its
            // `UnsupportedPlatformVersion` error stops the app from launching at
            // all on Windows 10.
            #[cfg(target_os = "macos")]
            let _ = window_vibrancy::apply_vibrancy(
                &app.get_webview_window("main").expect("the main window should exist"),
                window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
                Some(window_vibrancy::NSVisualEffectState::FollowsWindowActiveState),
                Some(12.0),
            );
            #[cfg(target_os = "windows")]
            let _ = window_vibrancy::apply_mica(
                &app.get_webview_window("main").expect("the main window should exist"),
                Some(true),
            );

            // CmdOrCtrl resolves to Command on macOS and Control on Windows /
            // Linux. These are native menu accelerators, not a WebView key
            // listener, so they remain predictable with any keyboard layout.
            let playback = SubmenuBuilder::new(app, "Playback")
                .item(&MenuItemBuilder::with_id("play-pause", "Play / Pause").accelerator("Space").build(app)?)
                .item(&MenuItemBuilder::with_id("previous", "Previous Track").accelerator("CmdOrCtrl+Left").build(app)?)
                .item(&MenuItemBuilder::with_id("next", "Next Track").accelerator("CmdOrCtrl+Right").build(app)?)
                .item(&MenuItemBuilder::with_id("volume-up", "Volume Up").accelerator("CmdOrCtrl+Up").build(app)?)
                .item(&MenuItemBuilder::with_id("volume-down", "Volume Down").accelerator("CmdOrCtrl+Down").build(app)?)
                .build()?;
            // Start from Tauri's platform-native menu template (application,
            // File/Edit, Window, Help) and add Tonearm's playback commands in
            // the conventional position before Window/Help.
            let menu = Menu::default(app.handle())?;
            #[cfg(target_os = "macos")]
            menu.insert(&playback, 3)?;
            #[cfg(not(target_os = "macos"))]
            menu.insert(&playback, 2)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let id = event.id().as_ref().replace('\\', "\\\\").replace('\'', "\\'");
                let _ = window.eval(&format!(
                    "window.dispatchEvent(new CustomEvent('tonearm:native-shortcut',{{detail:'{}'}}))",
                    id
                ));
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Tonearm");
}
