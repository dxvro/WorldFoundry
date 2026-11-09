# WorldFoundry: Step-by-step installation

> **WorldFoundry is not an official product of any game publisher.** The disclaimer of each game is in [TRADEMARKS.md](../TRADEMARKS.md).
> NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

WorldFoundry runs several Minecraft server instances on one computer. You operate it in a web browser from your local network (LAN).

This guide covers installing the ready-made packages on **Windows** and **Linux**. The [project README](../README.md) gives a short overview; further documentation is listed there. Everything here is taken from the installer files and the application.

> **Language note:** the installer dialogs and the web interface are in German. Menu and button names are given in German where you will see them on screen.

**Contents**

1. Requirements
2. Windows
3. Linux (systemd)
4. Reaching the web interface from other devices
5. Password and login
6. Updates
7. Troubleshooting
8. Configuration reference

---

## 1. Requirements

### 1.1 Hardware

- **RAM:** The WorldFoundry process itself is small. Most memory is used by the Minecraft servers (Java processes). A new server starts with a minimum of 1024 MB and a maximum of 2048 MB. You can change both per server in the wizard and on the server page. Plan the computer's RAM as: operating system, plus the maximum RAM of all servers that run at the same time, plus a reserve.
  As a rough rule of thumb (not a project figure): a small vanilla server for a few players runs with 2 to 4 GB. Modpacks often need 6 to 8 GB or more per server.
- **Disk space:** Servers, worlds, backups and Java runtimes. A Java runtime that WorldFoundry downloads is about 40 to 60 MB. Backups are stored as `.tar.gz` archives in the data folder, so plan room for several of them. WorldFoundry checks free space before it writes a backup.
- **CPU:** No minimum is defined. The dashboard shows the CPU count and load.

### 1.2 Network and ports

| Port | Protocol | Purpose | Who must reach it |
| --- | --- | --- | --- |
| 3000 (`PORT`) | TCP | Web interface and API. Can be changed in the web interface. | Devices on your LAN that manage servers |
| 25565 (and up to 25575) | TCP | Minecraft servers. Each server needs its own port. The installers open 25565 to 25575. | Players |

- Use a **fixed IP address** for the computer, so the address does not change (see section 4).
- **Do not forward port 3000 to the internet.** The web interface uses plain HTTP and can start programs. Forward only the Minecraft ports if players from outside should join. Use a VPN for remote management.
- **Virtual machines:** Use bridged networking, or forward the ports in the hypervisor. The default NAT mode is not reachable from the LAN.

### 1.3 Outbound internet access

The computer needs HTTPS access to these hosts, depending on what you use:

- **Java download:** `api.adoptium.net`, `github.com`, `release-assets.githubusercontent.com`
- **Minecraft and loader downloads:** `piston-data.mojang.com`, `launcher.mojang.com`, `meta.fabricmc.net`, `fill-data.papermc.io`, `maven.neoforged.net`, `maven.minecraftforge.net`
- **Mods:** `cdn.modrinth.com` and the Modrinth API
- **Update check (optional):** `api.github.com`, `github.com` and the GitHub download hosts

### 1.4 Browser

Any current desktop or mobile browser works. HTTPS is not required, so `http://<LAN address>:3000` is fine.

### 1.5 Java

You do **not** have to install Java yourself on Windows or Linux. Each Minecraft version needs a particular Java version. For example, Minecraft 1.21.1 needs Java 21, and 26.x needs Java 25. When a server needs a Java version that is missing, WorldFoundry downloads Eclipse Temurin for it into its data folder. This is the default (`JAVA_AUTO_INSTALL=true`).

If you set `JAVA_AUTO_INSTALL=false`, install the required Java version yourself and select it in the server settings.

### 1.6 Packages

Ready-made packages exist for **Windows x64**, **Linux x64** and **Linux arm64**. They are on the Releases page of the project on GitHub (no Git, npm, Node.js or Java is needed on the target computer):

| File | For |
| --- | --- |
| `worldfoundry-<version>-setup.exe` | Windows 10/11 and Windows Server 2016 or newer (x64), as a service |
| `worldfoundry-<version>-win-x64.zip` | Windows without installation and without a service (portable) |
| `worldfoundry-<version>-linux-x64.tar.gz` | Linux with systemd, Intel/AMD 64 bit |
| `worldfoundry-<version>-linux-arm64.tar.gz` | Linux with systemd, ARM 64 bit (e.g. Raspberry Pi 4/5 with a 64-bit system, Ampere/Graviton VMs) |
| `SHA256SUMS.txt` | Checksums of all files (`sha256sum -c` or `Get-FileHash`) |

Each package contains the official Node.js LTS runtime (only the executable, verified against `SHASUMS256.txt` from nodejs.org), the built application with its production dependencies, the matching native SQLite library (libsql) for the target system, and `LICENSE.txt` and `THIRD-PARTY-NOTICES.txt`. To build the packages yourself, see [DEVELOPMENT.md](DEVELOPMENT.md#building-the-packages-yourself).

---

## 2. Windows

### 2.1 Supported versions

- **64-bit (x64) only.** Windows on ARM is not supported.
- **Windows 10 or Windows 11, or Windows Server 2016 or newer.** The installer refuses older versions (`MinVersion=10.0` in `installer/windows/worldfoundry.iss`). The portable ZIP has no version check of its own, so use the same Windows versions for it.
- **Administrator rights** are needed for the installer, because it sets up a Windows service. Windows asks for confirmation (UAC).
- The Node.js runtime included in the package is shown in `version.json` in the installation folder (field `node`).

### 2.2 Option A: installer (recommended)

1. Open the releases page: <https://github.com/dxvro/WorldFoundry/releases>
   Download `worldfoundry-0.1.0-setup.exe` (replace `0.1.0` with the version you want) and `SHA256SUMS.txt`.

2. **Optional but recommended: check the checksum.** Open PowerShell in the download folder and run:

   ```powershell
   Get-FileHash .\worldfoundry-0.1.0-setup.exe
   ```

   Compare the `Hash` value with the line for the setup file in `SHA256SUMS.txt`. Upper and lower case do not matter.

3. Start the installer by double-clicking it. The installer is **not code-signed**, so Windows SmartScreen shows "Der Computer wurde durch Windows geschützt" (Windows protected your PC). Click **Weitere Informationen** (More info), then **Trotzdem ausführen** (Run anyway). Only do this if you trust the download and the checksum matches.

4. Confirm the UAC prompt.

5. Choose the installer language (English, or German as the second language) when asked, read the welcome page and click **Next** (German: **Weiter**). It repeats the disclaimer.

6. On the task page, choose the optional tasks:
   - **Windows Firewall** (German: **Windows-Firewall**): creates two inbound TCP rules for **private** networks only. One for the web port (3000, or the port in the configuration) and one for the Minecraft ports 25565 to 25575. Without this task, other devices on the LAN cannot reach the computer while the Windows firewall is on. Recommended.
   - **Start menu shortcut** (German: **Verknüpfung im Startmenü**): opens the web interface in your browser.

7. Click **Install** (German: **Installieren**). The installer copies the files, writes the configuration, registers the service `worldfoundry`, starts it, and waits until the web interface responds.

8. **Write down the access details.** The last page of the installer ("Access details"; "Zugangsdaten" in the German installer) shows:
   - the web addresses (`http://<computer name>:3000`, the LAN IP addresses, and `http://localhost:3000`)
   - the **access token** (first installation only). The token is also the first password for the web interface.

   The same data is stored in:
   - `C:\ProgramData\WorldFoundry\worldfoundry.env` (line `AUTH_TOKEN=`)
   - `C:\ProgramData\WorldFoundry\credentials.txt` (readable by administrators only; older versions called it `Zugangsdaten.txt`, which an update renames automatically). After you have noted the token, you may delete this file.

9. Open the address in your browser and log in with the token (section 5).

**Silent installation (optional, administrator command prompt):**

```bat
worldfoundry-0.1.0-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

Without `/TASKS`, both tasks (firewall and Start menu) are enabled. To choose them yourself, use `/TASKS="firewall,startmenu"`, or `/TASKS=""` for none. A silent installation shows no token, so read `credentials.txt` afterwards. A silent installation uses the language of the system (or of the previous installation); force one with `/LANG=english` or `/LANG=german`.

### 2.3 Option B: portable ZIP (no installer, no service)

Use this if you do not want a service or an installation. Note that the portable version is local-only by default.

1. Download `worldfoundry-0.1.0-win-x64.zip` and check its checksum as in step 2 of option A.
2. Extract the ZIP to a folder where your user account can write, for example `C:\WorldFoundry`. Do not use `Program Files`, because the data is written next to the script.
3. Double-click `start-portable.cmd`. On the first start, the script creates the folder `data` with the configuration, the data folders and `data\credentials.txt`, which contains the token. (Older portable versions used the folder `daten`; if it exists and `data` does not, the scripts keep using it.)
4. Open `http://localhost:3000` in your browser and log in.
5. **Allow LAN access (optional):** The portable version listens only on `127.0.0.1`. In the web interface, go to **System > Netzwerk & Zugriff**, set **Lauschen auf** to all network adapters, and click **Jetzt neu starten** (restart now). `start-portable.cmd` starts WorldFoundry again on its own after the restart. Then open the firewall for the web port (section 2.4).
6. Stop WorldFoundry with **Strg+C** in its window. Running Minecraft servers are stopped cleanly first.

The portable version does not start with Windows and has no self-update. To update it, extract the new ZIP and keep the `data` folder (or `daten` if you started with an older version).

### 2.4 Firewall

If you selected the **Windows-Firewall** task, the rules are already there. They are named `WorldFoundry - Web` and `WorldFoundry - Minecraft`, and they apply to the **Private** network profile only. If Windows classifies your network as **Public**, change it to **Private** in the Windows network settings first.

If you did not select the task (or use the portable version), run this in an **administrator** PowerShell. Use your web port if it is not 3000:

```powershell
New-NetFirewallRule -DisplayName "WorldFoundry" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "WorldFoundry Minecraft" -Direction Inbound -Protocol TCP -LocalPort 25565-25575 -Action Allow -Profile Private
```

If you change the web port in the web interface, the installer rule does not follow automatically. Run the installer again (it keeps your data and updates the rule to the current port), or add a rule for the new port by hand.

### 2.5 Service, folders and logs (installer version)

| What | Location |
| --- | --- |
| Program (Node.js, application, service wrapper) | `C:\Program Files\WorldFoundry` |
| Configuration (token, port, paths) | `C:\ProgramData\WorldFoundry\worldfoundry.env` |
| Database, Java runtimes, backups | `C:\ProgramData\WorldFoundry\data` |
| Minecraft servers | `C:\ProgramData\WorldFoundry\servers` |
| Service logs | `C:\ProgramData\WorldFoundry\logs` |

The product was called "WorldFoundry" before it was renamed to WorldFoundry. The program folder, the data folder, the update folder (`C:\ProgramData\WorldFoundry Update`), the Start menu folder and the Windows Firewall rule names keep the old name on purpose, so that existing installations are updated in place and keep their data.

- **Service:** `worldfoundry` (display name "WorldFoundry"). It starts automatically with Windows.
- **Service account:** `NT SERVICE\worldfoundry`, a virtual account without a password. It is not `SYSTEM`. Minecraft servers and mods run under the same account and have no administrator rights.
- **Manage the service:** in `services.msc`, or in an administrator PowerShell:

  ```powershell
  Get-Service worldfoundry
  Restart-Service worldfoundry
  Stop-Service worldfoundry
  Start-Service worldfoundry
  ```

  Changes to the configuration file take effect after a service restart.
- **Stopping:** when the service stops (also during an update and an uninstallation), the service wrapper WinSW first sends Ctrl+C to the application (`stopparentprocessfirst`) and waits up to 180 seconds (`stoptimeout`). In this time the application stops all Minecraft servers with `stop` (saves the world) and exits. Only after that is the process killed. If you raise `STOP_TIMEOUT_SECONDS` above about 160, also raise `<stoptimeout>` in `C:\Program Files\WorldFoundry\worldfoundry-service.xml` (and set up the service again, most simply by running the installer again). Windows gives services only limited time when shutting down or restarting, so if large worlds are running, stop the service yourself first.
- **Why a virtual service account:** `NT SERVICE\worldfoundry` is not shared with other services and limits the rights to exactly this folder. It can change only the data folder under `C:\ProgramData\WorldFoundry`; it can read the program files but not change them. The data folder is accessible only to `SYSTEM`, administrators and the service account, and the configuration file with the token is read-only for the service account.

### 2.6 Updating on Windows

- **In the app (recommended):** WorldFoundry shows a banner when a new release exists. Under **System > Updates**, click **Jetzt aktualisieren** (Update now) and confirm. See section 6.
- **By hand:** run the new `worldfoundry-<version>-setup.exe` over the existing installation. The installer stops the service, replaces the program files, starts the service again, and keeps your data, servers, configuration and token.
- **Earlier pre-release versions:** Installations of earlier pre-release versions (named WorldFoundry, up to 0.4.0) must install this release once by hand; afterwards updates are found automatically.
- **Portable version:** replace the program files with the new ZIP content and keep the `data` folder (or `daten` for older versions).

### 2.7 Uninstalling on Windows

1. Open **Einstellungen > Apps** (Settings > Apps), select **WorldFoundry**, and click **Deinstallieren** (Uninstall).
2. The uninstaller removes the service, the program files and the firewall rules.
3. **Your data stays** in `C:\ProgramData\WorldFoundry` (servers, worlds, backups, configuration). A later reinstallation finds everything again.
4. To remove everything, delete that folder by hand. This cannot be undone.

For the portable version, delete the folder. Back up `data` (or `daten`) first if you want to keep your servers.

---

## 3. Linux (systemd)

### 3.1 Compatible distributions

WorldFoundry for Linux is a systemd-based package. The installer needs these conditions:

1. **Architecture:** `x86_64` (64-bit Intel or AMD), use the `linux-x64` package. Or `aarch64` (64-bit ARM), use the `linux-arm64` package. 32-bit ARM (armv7) is not supported.
2. **systemd** as the init system. `install.sh` stops with an error if systemd is not running.
3. **glibc 2.28 or newer.** The bundled Node.js runtime uses the official Linux binaries, which need glibc 2.28 or newer. Alpine Linux and other musl-based systems are not supported.
4. **Root access** (`sudo`).

Check your system:

```bash
uname -m                              # x86_64 = linux-x64, aarch64 = linux-arm64
ldd --version                         # first line shows the glibc version, it must be 2.28 or newer
test -d /run/systemd/system && echo "systemd: yes"
```

**Distributions and versions that meet these conditions:**

| Distribution | Minimum version | glibc | Status |
| --- | --- | --- | --- |
| Ubuntu (Desktop and Server) | 20.04 LTS and newer | 2.31 and newer | **Tested in CI** (install, login, update and uninstall on the GitHub runner `ubuntu-latest`, which is an Ubuntu image). Other versions expected to work. |
| Linux Mint | 20 and newer (based on Ubuntu 20.04 and newer) | 2.31 and newer | Expected to work, not tested |
| Debian | 10 (buster), 11, 12, 13 | 2.28 and newer | Expected to work, not tested. Debian 12 or newer recommended, because 10 is past regular support. |
| Raspberry Pi OS **64-bit** | Bullseye (11) and Bookworm (12), 64-bit image only | 2.31 and newer | Expected to work, not tested. Raspberry Pi 4 or 5 with 64-bit OS, 4 GB RAM or more recommended (rule of thumb). |
| Ubuntu Server for Raspberry Pi (arm64) | 20.04 LTS and newer | 2.31 and newer | Expected to work, not tested |
| RHEL, Rocky Linux, AlmaLinux, Oracle Linux | 8, 9 and 10 | 2.28 (EL 8) and newer | Expected to work, not tested |
| CentOS Stream | 8 and 9 and newer | 2.28 and newer | Expected to work, not tested |
| Fedora | current supported releases | newer than 2.28 | Expected to work, not tested |
| openSUSE Leap | 15.2 and newer | 2.31 and newer | Expected to work, not tested |
| openSUSE Tumbleweed | rolling release | current | Expected to work, not tested |
| SUSE Linux Enterprise Server (SLES) | 15 SP2 and newer | 2.31 and newer | Expected to work, not tested |
| Arch Linux, Manjaro | rolling release | current | Expected to work, not tested |

**Too old or unsupported:**

- CentOS 7, RHEL 7 (glibc 2.17)
- Ubuntu 18.04 and older (glibc 2.27 and older)
- Debian 9 and older (glibc 2.24 and older)
- Alpine Linux and other musl-based systems
- Systems without systemd, for example Devuan (default sysvinit) or Void Linux with runit
- 32-bit ARM, for example Raspberry Pi OS 32-bit

### 3.2 Install the required tools

The installer uses standard tools that are present on all distributions listed above. You need `tar` and `gzip` to unpack the archive. If `tar` is missing, install it:

```bash
sudo apt install tar        # Debian, Ubuntu, Linux Mint, Raspberry Pi OS
sudo dnf install tar        # Fedora, RHEL, Rocky Linux, AlmaLinux, Oracle Linux
sudo zypper install tar     # openSUSE, SLES
sudo pacman -S tar          # Arch Linux, Manjaro
```

Install `gzip` the same way if it is missing. `sha256sum`, `useradd`/`groupadd`, `systemctl`, `sed` and `grep` are normally installed already. If one is missing, `install.sh` stops with a shell error message.

### 3.3 Step by step

**Step 1: download the package.** Open <https://github.com/dxvro/WorldFoundry/releases> and download:

- `worldfoundry-0.1.0-linux-x64.tar.gz` (Intel or AMD) **or** `worldfoundry-0.1.0-linux-arm64.tar.gz` (ARM 64-bit)
- `SHA256SUMS.txt`

Put both files in the same folder.

**Step 2: check the checksum.**

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

The output should contain `worldfoundry-0.1.0-linux-x64.tar.gz: OK` (or the arm64 file name). If it says `FAILED`, download the file again and do not install it.

**Step 3: extract the archive.**

```bash
tar -xzf worldfoundry-0.1.0-linux-x64.tar.gz
cd worldfoundry-0.1.0-linux-x64
```

**Step 4: run the installer.**

```bash
sudo ./install.sh
```

Options:

| Option | Meaning |
| --- | --- |
| `--port 8080` | Web port for the **first** installation (default 3000). Ignored on updates. |
| `--open-firewall` | Opens the web port and TCP 25565 to 25575 in `ufw` or `firewalld`, if one of them is active. |
| `--no-start` | Sets up the service but does not start it. |

The installer:

- creates the system user `worldfoundry` (no login shell)
- installs the program to `/opt/worldfoundry`
- creates the configuration `/etc/worldfoundry/worldfoundry.env` (mode 640, owner `root:worldfoundry`) with a random `AUTH_TOKEN`
- uses `/var/lib/worldfoundry` for data, Java runtimes and backups
- installs, enables and starts the systemd service `worldfoundry`
- installs the command `worldfoundry` (`/usr/local/bin/worldfoundry`)
- prints the web addresses and the access token at the end

**Write down the token and the addresses** that the installer prints.

**Step 5: check the service.**

```bash
systemctl status worldfoundry
journalctl -u worldfoundry -f
```

The journal shows the line `Weboberfläche erreichbar unter:` with the addresses. Stop following the log with Ctrl+C.

**Step 6: read the token again if needed.**

```bash
sudo grep AUTH_TOKEN /etc/worldfoundry/worldfoundry.env
```

**Step 7: open the firewall (if you did not use `--open-firewall`).** `install.sh` changes the firewall only when `ufw` or `firewalld` is active. Use your web port in place of 3000.

With `ufw`:

```bash
sudo ufw allow 3000/tcp
sudo ufw allow 25565:25575/tcp
```

With `firewalld`:

```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --permanent --add-port=25565-25575/tcp
sudo firewall-cmd --reload
```

**Step 8: open the web interface** at one of the printed addresses, for example `http://192.168.178.20:3000`, and log in (section 5).

### 3.4 Files, paths and service management

| What | Location |
| --- | --- |
| Program | `/opt/worldfoundry` |
| Configuration | `/etc/worldfoundry/worldfoundry.env` |
| Database, Java, backups | `/var/lib/worldfoundry` (`runtimes/`, `backups/`) |
| Minecraft servers | `/var/lib/worldfoundry/servers` |
| Log | `journalctl -u worldfoundry -f` |

```bash
sudo systemctl status worldfoundry
sudo systemctl restart worldfoundry
sudo systemctl stop worldfoundry
```

- The service restarts automatically after a crash (`Restart=on-failure`).
- On stop, systemd gives WorldFoundry up to 180 seconds (`TimeoutStopSec=180`) to stop all Minecraft servers cleanly. `SIGTERM` goes only to the application (`KillMode=mixed`), which shuts down all Minecraft servers with `stop`; only after the timeout is the rest killed with `SIGKILL`. If `STOP_TIMEOUT_SECONDS` is above about 160, also raise `TimeoutStopSec` with `systemctl edit`.
- The unit sets `NoNewPrivileges`, `ProtectSystem=strict` (write access only to `/var/lib/worldfoundry`), `ProtectHome`, `PrivateTmp`, and restricted address families and capabilities. It deliberately has **no** `MemoryDenyWriteExecute` and no system call filter, so that Java runs.
- The unit is hardened. WorldFoundry can write only to `/var/lib/worldfoundry`. If you set `SERVERS_DIR` to another folder, add that path to the service with `sudo systemctl edit worldfoundry` (`ReadWritePaths=`).

### 3.5 Updating on Linux

- **In the app (recommended):** see section 6.
- **By hand:** download the new archive, check its checksum, extract it, and run the installer in the new folder:

  ```bash
  tar -xzf worldfoundry-0.1.0-linux-x64.tar.gz
  cd worldfoundry-0.1.0-linux-x64
  sudo ./install.sh
  ```

  The installer stops the service (servers stop cleanly, which can take a few minutes), replaces the program files, keeps the data and configuration, and starts the service again. Database migrations run on start.
- **Earlier pre-release versions:** Installations of earlier pre-release versions (named WorldFoundry, up to 0.4.0) must install this release once by hand (`install.sh`); afterwards updates are found automatically.

### 3.6 Uninstalling on Linux

```bash
sudo /opt/worldfoundry/uninstall.sh
```

This removes the service, the program and the firewall rules that `--open-firewall` created. It **keeps** `/var/lib/worldfoundry` (servers, worlds, backups) and `/etc/worldfoundry` (configuration), so a later `sudo ./install.sh` finds everything again.

To remove everything:

```bash
sudo /opt/worldfoundry/uninstall.sh --purge
```

You are asked to type `ja`. Use `--yes` to skip the question. `--purge` deletes the servers, worlds, backups, configuration and the system user. This cannot be undone.

---

## 4. Reaching the web interface from other devices

**Address format:** `http://<computer name>:3000` or `http://<LAN IP>:3000`, for example `http://192.168.178.20:3000`.

**Find the address:**

- Installer (Windows): last page of the installer.
- Linux: the output of `install.sh`, or `journalctl -u worldfoundry`.
- In the web interface: **System > Netzwerk & Zugriff**.
- Command line: `ipconfig` (Windows) or `hostname -I` (Linux).

**Fixed address:** Give the computer a fixed IP address in your router (DHCP reservation). On a FRITZ!Box: **Heimnetz > Netzwerk**, edit the device, and enable **„Diesem Netzwerkgerät immer die gleiche IPv4-Adresse zuweisen“**. Alternatively, use a host name (see below).

**Host names:** WorldFoundry accepts the computer name and IP addresses. It also accepts names ending in `.local`, `.lan`, `.home`, `.home.arpa` and `.fritz.box`. For any other name, add it under **System > Netzwerk & Zugriff > Weitere erlaubte Rechnernamen**, or set `ALLOWED_HOSTS` in the configuration file. Otherwise the server answers `403 HOST_FORBIDDEN`.

**Change address and port:** open **System > Netzwerk & Zugriff** in the web interface:

| Setting | Meaning |
| --- | --- |
| Lauschen auf | All network adapters (`0.0.0.0`), one of the addresses of this computer, or `127.0.0.1` (this computer only) |
| Web-Port | 1 to 65535. The port must be free and must not belong to a Minecraft server. |
| Weitere erlaubte Rechnernamen | Extra host names, see above |
| Öffentliche Adresse | Optional, only displayed to users |

Changes take effect after a restart. Click **Jetzt neu starten** (restart now). WorldFoundry stops the running servers cleanly and restarts itself. The browser switches to the new address by itself.

After a port change, also update the firewall rule for the new port (section 2.4 on Windows, or `ufw`/`firewalld` on Linux).

**Note:** settings made in the web interface take precedence over `HOST`, `PORT` and `ALLOWED_HOSTS` in the configuration file. If you change the port only in the file and the web interface still has a port stored, the web interface value is used.

**Who restarts WorldFoundry after "Jetzt neu starten"?** WorldFoundry ends with exit code 75 and the servers that were running are started again after the restart:

| Installation | Restart after exit code 75 |
| --- | --- |
| Linux (systemd) | automatic: `Restart=on-failure` (and `RestartForceExitStatus=75`), after about 5 seconds |
| Windows service (WinSW) | automatic: recovery action "Restart" (`onfailure`), after 10 to 60 seconds |
| Portable ZIP | `start-portable.cmd` restarts itself on code 75 |
| Source (`npm start`, `npm run dev`) | start again by hand; the interface points this out |

**Safety net:** if the saved address no longer exists (adapter removed, address changed by the router), WorldFoundry listens on all adapters instead and writes a warning to the log. If the saved port is in use, the port from the configuration file is taken. The address actually used is stored in `<DATA_DIR>/network.json`. More details: [CONFIGURATION.md](CONFIGURATION.md#access-on-the-home-network).

---

## 5. Password and login

- **Access token:** At installation, a random token (`AUTH_TOKEN`, at least 8 characters) is created. It is the **first password** of the web interface.
- **Your own password:** Under **System > Passwort**, set a password of at least 10 characters. To change it, enter the current password (for the first change, the token). After the change, all other sessions are invalid.
- **Scripts and API:** The token stays the machine access. Send it as `Authorization: Bearer <token>`. Changing the password does not change the token. The token is changed only in the configuration file, followed by a service restart.
- **Failed logins:** After 5 wrong logins within 5 minutes, the IP address is blocked (HTTP 429) for a while.
- **No HTTPS:** The login protects against random access on the LAN. It does not protect against someone reading the traffic on your network. Do not share the token.
- **No token and no password** means open access for everyone who can reach the port. The installers always create a token, so this applies only if you have removed it yourself.

**Forgot the password?** Reset it only on the computer itself:

- **Linux:**

  ```bash
  sudo worldfoundry reset-password
  ```

  This creates and displays a new random password. To set your own password, use `--password-stdin` and pass the password on standard input. The service does not need to be stopped.
- **Windows (installed):** Start menu, folder **WorldFoundry** (the folder keeps the former product name, see section 2.5) **> Reset Password** (German installer: "Passwort zurücksetzen"). Windows asks for administrator rights.
- **Windows (portable):** run `reset-password.cmd` in the folder.

A reset ends all existing sessions. The access token is not changed.

---

## 6. Updates

- **Notification:** WorldFoundry checks GitHub for new releases every 6 hours, shortly after start, and on demand (**System > Updates > Jetzt prüfen**). A banner on every page shows the new version and its release notes.
- **Nothing installs by itself.** An administrator clicks **Jetzt aktualisieren** and confirms.
- **What happens during an update:**
  1. The package for your system is downloaded. Its signature and checksum are verified. Servers keep running during the download.
  2. A countdown starts (default 60 seconds, `UPDATE_COUNTDOWN_SECONDS`, 0 to 600). Players are warned in chat.
  3. Running servers are stopped cleanly (the world is saved).
  4. The update service installs the new version. It checks that the new version responds.
  5. The servers that were running are started again.
  The progress and history are shown under **System**. You can cancel during the countdown.
- **If the update fails,** the update service restores the previous version. A copy of the database is kept as `<DATA_DIR>/updates/db-before-update.db`.
- **Available for:** the Windows installer and the Linux installer. Portable and source installations only show a notice with a download link.
- **Turn it off:** set `UPDATE_CHECK=false` in the configuration file (no checks, no banner, no updates). To disable only the background check, switch off **Automatisch nach Updates suchen** under **System**.
- **Pre-releases:** `UPDATE_CHANNEL=prerelease` also offers pre-release versions. The default is `stable`.
- **More detail:** the chain of trust (signatures, privilege separation, rollback), the update API and how the owner publishes a release are in [UPDATES.md](UPDATES.md).

---

## 7. Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Other devices cannot open `http://<IP>:3000` | Firewall blocks the port, or the network is set to Public (Windows) | Open the port (sections 2.4 and 3.3). On Windows, set the network to Private. |
| Works on the computer itself, not from the LAN | Listening address is `127.0.0.1` (portable default, or **Nur dieser Rechner** in the settings) | Set **Lauschen auf** to all network adapters and restart (section 2.3 step 5). |
| Virtual machine not reachable | NAT networking | Use bridged networking, or forward the ports in the hypervisor. |
| `403 HOST_FORBIDDEN` | You open the page with a host name that is not allowed | Add the name under **Weitere erlaubte Rechnernamen** or in `ALLOWED_HOSTS`, or use the IP address. |
| Startup aborts with a message about the port being in use | Another program uses the web port | Choose another port in **System > Netzwerk & Zugriff** (or `PORT` in the configuration file if no web setting exists) and restart. |
| Minecraft server reports `409 PORT_IN_USE` | Another server or program uses the port | Give each server its own port. The default is 25565 for the first one. |
| `--port ... ignored` warning during install | The configuration already exists, so `--port` is ignored | Change `PORT` in `/etc/worldfoundry/worldfoundry.env` and restart the service. Note that a port set in the web interface takes precedence. |
| `systemd is required` during install | The system does not run systemd | Use a systemd-based distribution (section 3.1). |
| `The bundled Node executable cannot be started` | glibc older than 2.28, or a musl-based system such as Alpine | Check with `ldd --version`. Use a supported distribution (section 3.1). |
| `This package is for linux-x64, but this computer is linux-arm64` | Wrong archive for the processor | Download the matching archive (`uname -m`). |
| `The package is incomplete` | Archive not fully extracted | Extract the archive again. |
| Windows installer stops with an error mentioning the setup log | A step failed | Open the Inno Setup log. By default it is stored in your temp folder, and its file name starts with `Setup Log`. |
| Server stays in state `preparing` ("Java ... wird installiert") | Java download in progress or stuck | Check the server console. The download needs access to the Java hosts (section 1.3) and enough free disk space. |
| Error `JAVA_NOT_AVAILABLE` or `JAVA_PLATFORM_UNSUPPORTED` | No Temurin build for this Java version or platform | Use another Java version, or set `JAVA_AUTO_INSTALL=false` and install Java yourself. |
| Java download fails | No access to `api.adoptium.net`, `github.com` or `release-assets.githubusercontent.com`, or a proxy blocks it | Allow these hosts. |
| Server does not start: EULA | The Minecraft EULA has not been accepted for this server | Accept the EULA in the server settings. WorldFoundry never accepts it for you. |
| Backup fails with `507 DISK_FULL` | Not enough free disk space | Free space, or move `DATA_DIR`. |
| Players outside the LAN cannot connect | Router does not forward the Minecraft port | Forward TCP 25565 (or your server port) to the computer. |
| Service does not answer after installation | Start failed | Linux: `journalctl -u worldfoundry -e`. Windows: see the logs folder. |
| Service stops during Windows shutdown with large worlds | Windows gives services little time | Stop the `worldfoundry` service yourself before shutdown. |
| Update failed | Shown in the history under **System** | The previous version is restored automatically. The history gives the reason. |
| Uninstall left files | The data folder is kept on purpose | Delete the data folder by hand if you want everything removed. |

**Where to find logs**

| What | Where |
| --- | --- |
| WorldFoundry (Linux) | `journalctl -u worldfoundry -f` |
| WorldFoundry (Windows, installed) | `C:\ProgramData\WorldFoundry\logs` |
| Installation of a Minecraft server | `<SERVERS_DIR>/<server ID>/install.log`, also shown in the web interface |
| Console of a Minecraft server | Web interface, server page |

For more detail, set `LOG_LEVEL=debug` in the configuration file and restart the service. Set it back to `info` afterwards.

---

## 8. Configuration reference

The configuration file is:

- Windows (installed): `C:\ProgramData\WorldFoundry\worldfoundry.env`
- Windows (portable): `data\worldfoundry.env` (older versions: `daten\worldfoundry.env`) next to `start-portable.cmd`
- Linux: `/etc/worldfoundry/worldfoundry.env`

Restart the service after a change (`Restart-Service worldfoundry` or `sudo systemctl restart worldfoundry`). Real environment variables take precedence over the file. Settings changed in the web interface take precedence over the file for address, port and host names.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address to listen on. `127.0.0.1` means this computer only. |
| `PORT` | `3000` | Web port |
| `AUTH_TOKEN` | created by the installer | Access token, at least 8 characters. Enables the login. |
| `ALLOWED_HOSTS` | empty | Extra host names, without port, comma-separated |
| `DATA_DIR` | set by the installer (see below) | Database, Java runtimes and backups |
| `SERVERS_DIR` | set by the installer (see below) | Folder with the Minecraft servers |
| `JAVA_AUTO_INSTALL` | `true` | Download missing Java versions automatically |
| `STOP_TIMEOUT_SECONDS` | `120` | Seconds a server gets to save after `stop` (5 to 3600). Above about 160, also raise the service stop timeout (`stoptimeout` in `worldfoundry-service.xml` on Windows, `TimeoutStopSec` on Linux). |
| `MOD_BACKUP_KEEP` | `3` | Backups per mod kept after updates (1 to 100) |
| `IMPORT_MAX_MB` | `262144` | Largest accepted world archive in MB (default 256 GB). Free disk space is the real limit. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `UPDATE_CHECK` | `true` | Check for new releases |
| `UPDATE_CHANNEL` | `stable` | `stable` or `prerelease` |
| `UPDATE_COUNTDOWN_SECONDS` | `60` | Countdown before servers are stopped for an update (0 to 600) |

Installed locations of `DATA_DIR` and `SERVERS_DIR` are set by the installers: Windows `C:\ProgramData\WorldFoundry\data` and `...\servers`, Linux `/var/lib/worldfoundry` and `/var/lib/worldfoundry/servers`.
