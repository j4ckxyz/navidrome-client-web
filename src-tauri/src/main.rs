#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn app_icon_bytes(variant: &str) -> Result<&'static [u8], String> {
    match variant {
        "amber" => Ok(include_bytes!("../../public/icons/app-icons/amber.png")),
        "ocean" => Ok(include_bytes!("../../public/icons/app-icons/ocean.png")),
        "violet" => Ok(include_bytes!("../../public/icons/app-icons/violet.png")),
        "rose" => Ok(include_bytes!("../../public/icons/app-icons/rose.png")),
        _ => Err(format!("unknown app icon variant: {variant}")),
    }
}

#[cfg(target_os = "macos")]
fn set_macos_app_icon(bytes: &[u8]) -> Result<(), String> {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApp, NSImage};
    use objc2_foundation::NSData;

    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "the macOS app icon must be changed on the main thread".to_string())?;
    let data = NSData::with_bytes(bytes);
    let image = NSImage::initWithData(NSImage::alloc(), &data)
        .ok_or_else(|| "could not decode the selected app icon".to_string())?;

    // Apple documents applicationIconImage as the supported way to temporarily
    // change an app's Dock tile. The bundle/Finder icon remains the signed
    // default, while the user's choice is restored every time Tonearm starts.
    unsafe {
        NSApp(mtm).setApplicationIconImage(Some(&image));
    }
    Ok(())
}

#[tauri::command]
fn set_app_icon(_app: tauri::AppHandle, variant: String) -> Result<(), String> {
    let bytes = app_icon_bytes(&variant)?;

    #[cfg(target_os = "macos")]
    {
        set_macos_app_icon(bytes)
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri::Manager;
        let image = tauri::image::Image::from_bytes(bytes).map_err(|error| error.to_string())?;
        _app.get_webview_window("main")
            .ok_or_else(|| "the main window does not exist".to_string())?
            .set_icon(image)
            .map_err(|error| error.to_string())
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![set_app_icon])
        .setup(|app| {
            use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            use tauri::Manager;

            // AppImage users can update without opening the WebView:
            //   tonearm --update
            // (or run the downloaded .AppImage with the same flag).
            #[cfg(target_os = "linux")]
            if std::env::args().any(|argument| argument == "--update") {
                use tauri_plugin_updater::UpdaterExt;

                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let exit_code = match handle.updater() {
                        Err(error) => {
                            eprintln!("Tonearm update failed: {error}");
                            1
                        }
                        Ok(updater) => match updater.check().await {
                            Err(error) => {
                                eprintln!("Tonearm update check failed: {error}");
                                1
                            }
                            Ok(None) => {
                                println!("Tonearm is already up to date.");
                                0
                            }
                            Ok(Some(update)) => {
                                println!(
                                    "Updating Tonearm {} → {}…",
                                    update.current_version, update.version
                                );
                                match update
                                    .download_and_install(
                                        |_chunk_length, _content_length| {},
                                        || println!("Download complete; installing…"),
                                    )
                                    .await
                                {
                                    Ok(()) => {
                                        println!("Tonearm was updated successfully.");
                                        0
                                    }
                                    Err(error) => {
                                        eprintln!("Tonearm update failed: {error}");
                                        1
                                    }
                                }
                            }
                        },
                    };
                    handle.exit(exit_code);
                });
                return Ok(());
            }

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

            // Keep playback actions visible in the native menu, but do not add
            // menu accelerators here. AppKit processes menu key equivalents
            // before the WebView can see which control has focus: the previous
            // Cmd+Left binding therefore restarted a track when someone used
            // the standard macOS cursor-to-line-start command in Search. The
            // WebView shortcut layer is focus-aware and remains authoritative.
            let playback = SubmenuBuilder::new(app, "Playback")
                .item(&MenuItemBuilder::with_id("play-pause", "Play / Pause").build(app)?)
                .item(&MenuItemBuilder::with_id("previous", "Previous Track").build(app)?)
                .item(&MenuItemBuilder::with_id("next", "Next Track").build(app)?)
                .item(&MenuItemBuilder::with_id("volume-up", "Volume Up").build(app)?)
                .item(&MenuItemBuilder::with_id("volume-down", "Volume Down").build(app)?)
                .build()?;
            // Start from Tauri's platform-native menu template (application,
            // File/Edit, Window, Help) and add Tonearm's playback commands in
            // the conventional position before Window/Help.
            let menu = Menu::default(app.handle())?;
            #[cfg(target_os = "macos")]
            {
                // macOS convention: global settings live in the application
                // menu and use Command-comma. Update checking belongs beside
                // it rather than buried in a web-only download card.
                let settings = MenuItemBuilder::with_id("open-settings", "Settings…")
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;
                let updates =
                    MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
                let items = menu.items()?;
                if let Some(app_menu) = items.first().and_then(|item| item.as_submenu()) {
                    app_menu.insert_items(&[&settings, &updates], 1)?;
                }
            }
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
        .on_window_event(|window, event| {
            // A macOS window's close button closes the window, not the
            // application. Keep Tonearm and its playback session alive until
            // the user chooses Quit from the application menu.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Tonearm")
        .run(|app, event| {
            // Clicking the Dock icon after closing the window should restore
            // and focus the existing player, as users expect from a macOS app.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                use tauri::Manager;
                if !has_visible_windows {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        });
}
