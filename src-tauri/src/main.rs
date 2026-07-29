#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            use tauri::Manager;

            // Use the compositor effects users expect on each desktop instead
            // of imitating them in CSS. Unsupported systems simply retain the
            // normal opaque background, so this never affects startup.
            #[cfg(target_os = "macos")]
            window_vibrancy::apply_vibrancy(
                &app.get_webview_window("main").expect("the main window should exist"),
                window_vibrancy::NSVisualEffectMaterial::HudWindow,
                Some(window_vibrancy::NSVisualEffectState::Active),
                Some(12.0),
            )?;
            #[cfg(target_os = "windows")]
            window_vibrancy::apply_mica(
                &app.get_webview_window("main").expect("the main window should exist"),
                Some(true),
            )?;

            // CmdOrCtrl resolves to Command on macOS and Control on Windows /
            // Linux. These are native menu accelerators, not a WebView key
            // listener, so they remain predictable with any keyboard layout.
            // A WebView does not get the conventional application menu for
            // free. Use native predefined items so macOS/Windows can route
            // editing commands to the focused text field and expose the
            // expected application/window shortcuts to accessibility tools.
            let app_menu = SubmenuBuilder::new(app, "Tonearm")
                .item(&PredefinedMenuItem::about(app, Some("About Tonearm"), None)?)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;
            let edit = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;
            let window = SubmenuBuilder::new(app, "Window")
                .item(&PredefinedMenuItem::minimize(app, None)?)
                .item(&PredefinedMenuItem::maximize(app, None)?)
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;
            let playback = SubmenuBuilder::new(app, "Playback")
                .item(&MenuItemBuilder::with_id("play-pause", "Play / Pause").accelerator("Space").build(app)?)
                .item(&MenuItemBuilder::with_id("previous", "Previous Track").accelerator("CmdOrCtrl+Left").build(app)?)
                .item(&MenuItemBuilder::with_id("next", "Next Track").accelerator("CmdOrCtrl+Right").build(app)?)
                .item(&MenuItemBuilder::with_id("volume-up", "Volume Up").accelerator("CmdOrCtrl+Up").build(app)?)
                .item(&MenuItemBuilder::with_id("volume-down", "Volume Down").accelerator("CmdOrCtrl+Down").build(app)?)
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit, &playback, &window])
                .build()?;
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
