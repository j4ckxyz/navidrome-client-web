# Updating on a schedule

Let your own machine run the updater on a timer. This is the safest way to get
automatic updates: Tonearm itself gains no extra permissions, unlike the
`SELF_UPDATE` option, which needs control of Docker.

`bun run update` is built for this — it asks nothing, and `--quiet` means it
prints only when something actually changed or failed, so a nightly job stays out
of your logs unless it matters.

**Two things apply to all of these:**

- Docker has to be running when the job fires. On macOS and Windows, set Docker
  Desktop to start at login.
- An update restarts Tonearm, so anyone listening has to reload the page. Pick an
  hour when nobody is — the examples use 04:17.

First find the full path to `bun`. Schedulers run with a bare-bones `PATH`, so
just writing `bun` usually won't work:

```bash
which bun          # macOS / Linux  → e.g. /Users/you/.bun/bin/bun
where.exe bun      # Windows        → e.g. C:\Users\you\.bun\bin\bun.exe
```

Use that path, and your own install folder, in whichever recipe fits.

## Linux — systemd timer

The right choice on a server: it doesn't depend on anyone being logged in.

```ini
# /etc/systemd/system/tonearm-update.service
[Unit]
Description=Update Tonearm
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/srv/tonearm
ExecStart=/usr/local/bin/bun run update --quiet
```

```ini
# /etc/systemd/system/tonearm-update.timer
[Unit]
Description=Update Tonearm nightly

[Timer]
OnCalendar=daily
RandomizedDelaySec=30m
Persistent=true      # catch up after the machine was off

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tonearm-update.timer

systemctl list-timers tonearm-update.timer    # confirm it's scheduled
sudo systemctl start tonearm-update.service   # run it once now, to test
journalctl -u tonearm-update.service          # see what it did
```

Prefer cron?

```
17 4 * * * cd /srv/tonearm && /usr/local/bin/bun run update --quiet
```

## macOS — launchd agent

Use a LaunchAgent, not a daemon: Docker Desktop runs as your logged-in user, so a
system-level job would fire with no Docker there to answer.

```xml
<!-- ~/Library/LaunchAgents/com.tonearm.update.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.tonearm.update</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.bun/bin/bun</string>
    <string>run</string>
    <string>update</string>
    <string>--quiet</string>
  </array>
  <key>WorkingDirectory</key> <string>/Users/you/tonearm</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>   <integer>4</integer>
    <key>Minute</key> <integer>17</integer>
  </dict>
  <key>StandardOutPath</key>  <string>/tmp/tonearm-update.log</string>
  <key>StandardErrorPath</key><string>/tmp/tonearm-update.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tonearm.update.plist
launchctl kickstart -p gui/$(id -u)/com.tonearm.update   # run once now, to test
cat /tmp/tonearm-update.log                              # see what it did
```

Remove it with `launchctl bootout gui/$(id -u)/com.tonearm.update`. If the Mac is
asleep at the scheduled time, the job runs once it wakes.

## Windows — Task Scheduler

Run it as yourself: Docker Desktop runs in your session, so "run whether user is
logged on or not" would fire with no Docker to talk to.

In PowerShell:

```powershell
$bun = "$env:USERPROFILE\.bun\bin\bun.exe"
$dir = "$env:USERPROFILE\tonearm"

$action   = New-ScheduledTaskAction -Execute $bun `
              -Argument "run update --quiet" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -Daily -At 4:17am
# StartWhenAvailable catches up after the PC was off at the scheduled time.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
              -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName "Tonearm update" `
  -Action $action -Trigger $trigger -Settings $settings
```

```powershell
Start-ScheduledTask   -TaskName "Tonearm update"   # run once now, to test
Get-ScheduledTaskInfo -TaskName "Tonearm update"   # LastTaskResult 0 = OK
```

Remove it with `Unregister-ScheduledTask -TaskName "Tonearm update"`.
