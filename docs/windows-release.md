# Windows releases

Notes on the two Windows problems that are easy to hit and hard to diagnose:
the app failing to start, and Windows Security deleting the installer.

## Window effects must stay optional

`window_vibrancy::apply_mica` is only supported from Windows 11 build 22000. On
Windows 10 it returns `UnsupportedPlatformVersion`, so propagating that error out
of Tauri's `setup` hook stops the app from launching at all — not just without
the blur. `src-tauri/src/main.rs` therefore discards the result of both the macOS
and Windows effect calls; an unsupported compositor leaves an opaque window.

Windows also does not support a transparent window together with decorations, so
`src-tauri/tauri.windows.conf.json` overrides `transparent` to `false`. That file
is merged over `tauri.conf.json` automatically for Windows targets. Note that
Tauri replaces arrays wholesale during that merge, so the `app.windows` entry has
to repeat every field it wants to keep, not just the ones it changes.

`titleBarStyle: "Overlay"` and `hiddenTitle` are macOS-only. Because only macOS
hides its caption behind the content, only macOS gets the 34px reserved strip in
`global.css` (`.tauri-overlay-titlebar`). Applying it on Windows produced a
second, dead title bar covering the top of the UI.

## Windows Security deleting the installer

An unsigned installer with no download history has no SmartScreen or Defender
reputation, which is the whole cause. Nothing below is a substitute for signing;
they only reduce how often the heuristics fire.

Already applied in `tauri.conf.json`:

- `publisher`, `homepage`, `copyright` and `longDescription`, so the installer
  carries useful product metadata. These fields do **not** change the
  Authenticode identity: Windows still shows "Unknown publisher" until the
  executable is code-signed.
- `webviewInstallMode: embedBootstrapper` — the default `downloadBootstrapper`
  makes the installer fetch the WebView2 runtime over the network at install
  time, which is exactly the dropper behaviour heuristics look for. Escalate to
  `offlineInstaller` if reports continue; it embeds the full runtime and never
  touches the network, at roughly +120 MB.
- `nsis.installMode: both` — `currentUser` installs into `%LOCALAPPDATA%`, and
  unsigned executables running from AppData are treated more harshly. The
  installer lets the user choose a per-user install or a system-wide install;
  only the system-wide choice requires elevation.
- The workflow builds `nsis,msi`. An `.msi` executed by `msiexec` is generally
  treated better than a self-extracting `.exe`, so it is the fallback to point
  users at when the setup `.exe` is quarantined.

Note that the advice to avoid packers and obfuscators does not apply here.
Tauri's NSIS bundler does not use UPX, and the `[profile.release]` settings in
`Cargo.toml` (`lto`, `opt-level = "s"`, `strip`) are ordinary Rust release
options, not entropy-raising packing. Removing them would not change AV
behaviour.

If a build is flagged, report the false positive to Microsoft at
<https://www.microsoft.com/en-us/wdsi/filesubmission>. This is free, usually
turned around within a day or two, and is the only quick fix available for an
unsigned binary. It has to be repeated for each new release.

## Code signing

Authenticode signing is the actual fix. The workflow supports it already and
stays inert without the secrets, so unsigned builds keep working for forks.

Options, cheapest first:

| Option | Cost | Notes |
| --- | --- | --- |
| [SignPath Foundation](https://signpath.org/) | Free | For OSS projects; requires an application and review. |
| [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/) | ~$10/month | Needs identity validation; organisations must be 3+ years old, individual validation is also available. |
| OV certificate (Sectigo, SSL.com, …) | ~$200–400/year | Requires a hardware token or cloud HSM. |
| EV certificate | ~$400–700/year | Only option that grants SmartScreen reputation immediately. |

Note that OV certificates still start with zero SmartScreen reputation, which
builds up over downloads. Only EV skips that.

The workflow is wired for Azure Trusted Signing. Set these repository secrets and
signing switches on by itself:

- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` — service
  principal with the *Trusted Signing Certificate Profile Signer* role.
- `WINDOWS_SIGNING_ENDPOINT` — for example `https://eus.codesigning.azure.net`.
- `WINDOWS_SIGNING_ACCOUNT`, `WINDOWS_SIGNING_PROFILE`.

`scripts/enable-windows-signing.ts` then writes a `signCommand` into the Windows
config during the run. It deliberately fails the build if the secrets are only
partially set, rather than silently shipping unsigned installers.

For a different provider, replace that `signCommand` with any tool that signs
the file passed as `%1`.

## Publishing

`tauri-action` creates the release as a draft and only un-drafts it from the job
that created it, so a matrix build can finish with every installer uploaded to a
release nobody can download. The separate `publish` job runs after all three
platforms succeed and sets the release live with `gh release edit --draft=false`.

Release tags should be `v`-prefixed (`v0.1.0`). Running the workflow manually
with a branch name creates a release tagged with that branch name, which is what
produced the draft tagged `main`.
