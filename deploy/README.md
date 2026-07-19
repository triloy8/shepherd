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

Only two repository-owned runtime scripts are active; the existing
`~/nio_starter.sh` remains the device-specific chroot launcher. A separate
setup script handles one-time provisioning:

- `deploy/termux/start-shepherd.sh` calls the existing chroot launcher at
  `~/nio_starter.sh` during boot.
- `deploy/ubuntu/start-shepherd.sh` manages Shepherd in tmux as `nio`.
- `deploy/ubuntu/setup.sh` installs and refreshes Ubuntu dependencies.

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

The setup script installs Ubuntu packages, Bun, the official Codex CLI package,
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

Set `DISCORD_BOT_TOKEN` in `envs/discord.env`. For the initial deployment, keep
these settings in `envs/common.env`:

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

Verify Shepherd:

```bash
bun run check
bun test
bun run start
```

Wait for `discord bridge ready`, verify the bot in Discord, then press `Ctrl-C`.

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

Inside Ubuntu as `nio`:

```bash
cd /home/nio/shepherd
./deploy/ubuntu/start-shepherd.sh stop
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
