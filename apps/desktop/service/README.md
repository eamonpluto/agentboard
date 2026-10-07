# CrewBus desktop — background-service units (copy-paste for Phase B5)

Neither Tauri nor Electron is an OS service manager; these files register
the built app so the sidecar survives window close. All three only manage
the shell **process** — board state under `.crewbus/` is never touched.

| OS | File | Install (copy-paste) |
|---|---|---|
| Windows (logon task, recommended) | `windows/CrewBus-Logon.xml` | `windows\install.cmd` (registers `schtasks /create /tn "CrewBus"`); verify `schtasks /query /tn "CrewBus"` |
| Windows (service alt.) | `windows/crewbus-desktop-winsw.xml` | `WinSW-x64.exe install crewbus-desktop-winsw.xml` — pick this OR the logon task, not both |
| macOS | `macos/com.crewbus.desktop.plist` | `cp` to `~/Library/LaunchAgents/` + `launchctl load` (commands in the file header) |
| Linux | `linux/crewbus-desktop.service` | `cp` to `~/.config/systemd/user/` + `systemctl --user enable --now` (commands in the file header) |

Prerequisites before registering any of these:

1. A signed, installed build (`npm run tauri build` on the toolchain machine).
2. The single-instance plugin landed (see `src-tauri/src/main.rs` TODOs) —
   without it, a second launch would boot a second sidecar on a new random
   port. The Task Scheduler XML sets `IgnoreNew`, but that only dedupes the
   task itself, not manual launches.
3. Adjust the exe path in the file if your install location differs from the
   default noted in each header (per-user vs per-machine on Windows;
   non-`/Applications` on macOS; distro bundle path on Linux).

Verify after install: reboot (or log off/on), then check the dashboard is
reachable and `serve` bound `127.0.0.1` only (never `0.0.0.0` — the sidecar
constructor refuses non-loopback hosts).
