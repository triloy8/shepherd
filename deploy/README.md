# Shepherd deployment on rooted Android

Shepherd runs directly inside an Ubuntu 24.04 chroot and is supervised by
`tmux`. Docker is not required for the phone deployment.

This setup follows LinuxDroidMaster's
[Ubuntu chroot tutorial](https://github.com/LinuxDroidMaster/Termux-Desktops/blob/main/Documentation/chroot/ubuntu_chroot.md)
and assumes:

- Ubuntu rootfs: `/data/local/chroot/ubuntu`
- Ubuntu user: `nio`
- Shepherd checkout: `/home/nio/shepherd`
- Termux home: `/data/data/com.termux/files/home`

The repository owns the Ubuntu service launchers; the existing
`~/nio_starter.sh` remains the device-specific chroot launcher. A separate
setup script handles one-time provisioning:

- `deploy/termux/start-shepherd.sh` calls the existing chroot launcher at
  `~/nio_starter.sh` during boot.
- `deploy/ubuntu/start-shepherd.sh` manages Shepherd in tmux as `nio`.
- `deploy/ubuntu/setup.sh` installs and refreshes Ubuntu dependencies.
- `deploy/ubuntu/tailscale.sh` optionally installs and supervises private host networking.

> [!CAUTION]
> Chroot mounts can remain active after leaving Ubuntu. Never delete or move
> `/data/local/chroot/ubuntu` while it is mounted.

## 1. Prepare the checkout and install tools

Enter Ubuntu as `nio`. For a new checkout:

```bash
cd /home/nio
git clone https://github.com/triloy8/shepherd.git
```

For an existing checkout:

```bash
cd /home/nio/shepherd
git pull --ff-only
```

Then run the idempotent setup:

```bash
cd /home/nio/shepherd
./deploy/ubuntu/setup.sh
```

The setup script installs Ubuntu packages, Bun, Codex CLI `0.154.0`,
project dependencies, and missing runtime environment files. Existing `.env`
files are preserved. It is safe to rerun after updates.

Start a new login shell if Bun was installed for the first time, then verify:

```bash
exec "$SHELL" -l
bun --version
codex --version
gh --version
tmux -V
```

OpenAI's [Codex CLI getting-started guide](https://help.openai.com/en/articles/11096431)
identifies `@openai/codex` as the official package.

## 2. Configure Shepherd inside Ubuntu

Set `DISCORD_BOT_TOKEN` in `envs/discord.env`. For the initial deployment,
keep these settings in `envs/common.env`:

```env
CODEX_APPROVAL_POLICY=on-request
CODEX_SANDBOX=workspace-write
```

Authenticate as `nio`:

```bash
codex login
gh auth login
codex login status
gh auth status
```

If needed, use `codex login --device-auth` on the phone.

Install the generic skills as `nio` at `/home/nio/.agents/skills` and preserve
or configure `github/local.env` using the
[shared skills guide](../.docs/shared-skills-location.md). The host processes
inherit `HOME=/home/nio`, so the standard installation needs no
`SHEPHERD_SKILLS_DIR` override or launcher change. Install skills once; they are
not automatically updated when Shepherd starts or deploys.

Verify Shepherd:

```bash
bun run check
bun test
bun run start
```

Wait for `discord bridge ready`, verify the bot in Discord, then press `Ctrl-C`.

## Optional private networking with Tailscale

Install Tailscale during provisioning with:

```bash
./deploy/ubuntu/setup.sh --with-tailscale
```

On an already provisioned host, install only Tailscale without sudo:

```bash
./deploy/ubuntu/tailscale.sh install
./deploy/ubuntu/tailscale.sh login
```

The installer downloads the official Tailscale `1.102.4` static archive for
ARM64 or AMD64, verifies its published SHA-256 checksum, and enables startup
only after successful installation. Downloads happen only during explicit
installation, never at boot. Existing version directories are reused; an
installation does not restart a running daemon. The checksum is fetched over
HTTPS from the same official release source.

Open the login link using your personal Tailscale account. Sign in to that
same tailnet in the client’s Tailscale app. Login is explicit and bounded
to 60 seconds; if it times out, complete authorization and check status, or
rerun login. Login sets hostname `shepherd-host`, disables DNS management and
route acceptance. Boot does not run login or change saved network preferences.

The daemon runs as the Ubuntu user in userspace networking mode, without root,
TUN configuration, or system routing changes. This mode provides the basis for
future Tailscale Serve previews; it does not make arbitrary host applications
or outbound connections automatically use Tailscale. This installation exposes
no website and configures neither Serve nor Funnel.

State and device identity live in `~/.local/state/tailscale` (mode 700), outside
the checkout. Binaries live in `~/.local/lib/tailscale`. Preserve the state
folder across updates and rollbacks; never commit it. Its `enabled` marker opts
this host into automatic startup. Setup without `--with-tailscale` preserves
that choice.

The existing Termux → chroot → Ubuntu startup chain starts an independent
`shepherd-tailscale` tmux supervisor before starting Shepherd. It retries daemon
exits every five seconds. An unauthenticated or disconnected daemon remains
running for recovery. Missing Tailscale binaries produce a warning but do not
prevent Shepherd startup. Repeated startup is safe; stopping or redeploying
Shepherd leaves Tailscale running. A lock prevents duplicate supervisors.
Android must still allow Termux:Boot and the chroot to run in the background;
this cannot recover from Android killing the entire host environment.

```bash
./deploy/ubuntu/tailscale.sh status
./deploy/ubuntu/tailscale.sh logs
./deploy/ubuntu/tailscale.sh stop     # temporary; next host start enables it again
./deploy/ubuntu/tailscale.sh start
./deploy/ubuntu/tailscale.sh disable  # stop and opt out; preserve device identity
./deploy/ubuntu/tailscale.sh cli ping 'CLIENT_HOSTNAME'  # replace with a hostname from status
```

To re-enable, rerun `install`, then `start`; existing authentication is retained.
To inspect detailed health, use `cli status --json`. A running tmux session is
not proof of tailnet connectivity. Logs are in `~/.local/state/tailscale/daemon.log`;
log rotation is not currently configured.

### Adopt the manually installed host

For an existing manual installation using the paths above, run
`install`, then `stop` and `start` once to replace the temporary tmux session
with the repository supervisor. This briefly interrupts private networking but
does not log out or restart Shepherd. A daemon started outside this tmux session
is left alone; stop it using its original launcher before handing supervision
to this script. Do not run two daemons against the same state directory.

After merging, run these commands from the updated host checkout. Normal
`!deploy` does not install host binaries or restart this independent service.
No change to the Android-side launcher is needed when it already invokes
`deploy/ubuntu/start-shepherd.sh start`. Verify a real reboot from Termux before
relying on unattended startup.

## 3. Start Shepherd inside Ubuntu

```bash
cd /home/nio/shepherd
./deploy/ubuntu/start-shepherd.sh start
```

The script creates a detached tmux session named `shepherd`, restarts the bot
five seconds after an unexpected exit, and logs to `logs/shepherd.log`.

```bash
./deploy/ubuntu/start-shepherd.sh status
./deploy/ubuntu/start-shepherd.sh logs
tmux attach -t shepherd
./deploy/ubuntu/start-shepherd.sh stop
```

Detach from tmux without stopping Shepherd with `Ctrl-b`, then `d`.

## 4. Add Shepherd mode to the existing chroot launcher

Perform this section in native Termux, outside Ubuntu. The existing
`~/nio_starter.sh` already owns the Android mounts and chroot entry. Replace its
first line:

```sh
#!/bin/sh
```

with the Android shell path:

```sh
#!/system/bin/sh
```

Then replace its existing interactive chroot command:

```sh
busybox chroot $UBUNTUPATH /bin/su - nio
```

with:

```sh
case "${1:-interactive}" in
  shepherd)
    exec busybox chroot "$UBUNTUPATH" /bin/su - nio -c \
      '/home/nio/shepherd/deploy/ubuntu/start-shepherd.sh start'
    ;;
  interactive)
    exec busybox chroot "$UBUNTUPATH" /bin/su - nio
    ;;
  *)
    echo "usage: $0 [interactive|shepherd]" >&2
    exit 2
    ;;
esac
```

Make sure the launcher is executable:

```bash
chmod 700 ~/nio_starter.sh
```

Its behavior is now:

```bash
sudo ~/nio_starter.sh             # interactive Ubuntu shell as nio
sudo ~/nio_starter.sh shepherd    # start Shepherd and return
```

## 5. Install the Termux:Boot script

Still in native Termux, install Termux:Boot from the same source as Termux, open
its launcher icon once, and exempt both apps from Android battery and
background restrictions.

Copy the boot script from the Android-side path of the Ubuntu rootfs:

```bash
mkdir -p ~/.termux/boot
sudo cp \
  /data/local/chroot/ubuntu/home/nio/shepherd/deploy/termux/start-shepherd.sh \
  ~/.termux/boot/shepherd
sudo chown "$(id -u):$(id -g)" ~/.termux/boot/shepherd
chmod 700 ~/.termux/boot/shepherd
```

Fully exit the chroot first so its mounts are not duplicated, then test the
complete boot path:

```bash
~/.termux/boot/shepherd
sleep 5
tail -n 100 ~/.cache/shepherd-boot.log
```

Enter Ubuntu normally and verify:

```bash
/home/nio/shepherd/deploy/ubuntu/start-shepherd.sh status
/home/nio/shepherd/deploy/ubuntu/start-shepherd.sh logs
```

## Updating

When the pinned Codex version changes, rerun `./deploy/ubuntu/setup.sh` from the
updated checkout as `nio`, then check `codex --version`. The current default is
`0.154.0`; `CODEX_VERSION` can override it explicitly. The Discord `!deploy`
command updates Shepherd's checkout and dependencies, not the globally installed
Codex executable.


The normal update flow is:

```text
develop in an isolated workspace
→ push the working branch
→ run !deploy branch <branch-name> for user-level preview testing
→ open and merge a PR into main
→ run !deploy in Discord
→ wait for Shepherd to reconnect
→ copy the posted !repo and !thread recovery commands
```

Bare `!deploy` fetches and validates the latest `origin/main` while the current
bot remains online. `!deploy branch <branch-name>` applies the same clean-checkout,
validation, rollback, and restart flow to an exact remote branch commit for
preview testing. Run `!deploy status` to inspect the current commit and matching
locally fetched remote refs, and run bare `!deploy` after preview testing to
return to stable main. Shepherd stores no separate deployment state. On success,
it exits and the tmux supervisor starts the updated checkout. On validation
failure, it restores the previous commit and stays online. Each deployment
subprocess has a 30-minute timeout by default. Set
`SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS` in `envs/common.env` to a positive number
of milliseconds if this deployment needs a different limit.

For manual recovery when Discord is unavailable, enter Ubuntu as `nio` and run:

```bash
cd /home/nio/shepherd
./deploy/ubuntu/start-shepherd.sh stop
git switch main
git pull --ff-only
./deploy/ubuntu/setup.sh
bun run check
bun test
./deploy/ubuntu/start-shepherd.sh start
```

If `deploy/termux/start-shepherd.sh` changed, repeat the copy command from the
Termux:Boot section.

## Optional Docker files

`Dockerfile`, `compose.yaml`, and `.dockerignore` are retained for a future
deployment on a compatible Linux kernel. They are not used on this phone.

Docker Compose mounts the host's shared skills at `~/.agents/skills`; set
`SHEPHERD_SKILLS_DIR` in the Compose interpolation environment to use another
host path. It no longer expects vendored `.agents/skills` in the checkout.
