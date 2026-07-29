# Desktop updates

Tonearm uses Tauri's signed updater. This signature is mandatory on macOS,
Windows and Linux and is independent of Apple Developer ID, Windows
Authenticode, or the TLS certificate used by GitHub.

The macOS bundle also uses Tauri's recommended ad-hoc signing identity (`-`).
That produces a structurally valid Apple Silicon bundle without a paid
certificate, but it does not verify the publisher or replace Developer ID
notarisation.

The public key is committed in `src-tauri/tauri.conf.json`. The encrypted private
key is backed up locally at `~/.tauri/tonearm.key` with mode `0600`, and its
password is stored in macOS Keychain under service
`app.tonearm.desktop.updater`. GitHub Actions has matching
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets.
Losing both the private key and its password means installed copies can no
longer trust future updates, so do not rotate or replace them during routine
releases.

To retrieve the local password for disaster recovery:

```bash
security find-generic-password \
  -a j4ck.xyz \
  -s app.tonearm.desktop.updater \
  -w
```

Once provisioned, release builds create the platform updater artifacts plus
`latest.json`. Tauri fetches that manifest from:

```text
https://github.com/j4ckxyz/navidrome-client-web/releases/latest/download/latest.json
```

macOS and Windows users can check and install from Settings, or use the macOS
application menu. Linux AppImage users can update without opening the WebView:

```bash
tonearm --update
```

If the executable is not on `PATH`, invoke the AppImage directly:

```bash
./Tonearm.AppImage --update
```

An update is offered only when the release version is newer than the installed
version. Bump both `package.json` and `src-tauri/tauri.conf.json` together for
every desktop release.
