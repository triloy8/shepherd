# Shepherd deployment on rooted Android

This deployment is for a rooted Android phone running Docker inside an Ubuntu
24.04 chroot launched from Termux. It follows LinuxDroidMaster's
[Ubuntu chroot tutorial](https://github.com/LinuxDroidMaster/Termux-Desktops/blob/main/Documentation/chroot/ubuntu_chroot.md)
and assumes the layout created by that tutorial:

- Ubuntu rootfs: `/data/local/chroot/ubuntu`
- Interactive/desktop launcher: `/data/local/chroot/start_ubuntu.sh`
- Shepherd checkout inside Ubuntu: `/root/shepherd`
- Termux home: `/data/data/com.termux/files/home`

This is a real, root-backed `chroot`, not `proot-distro`. Shepherd runs as a
Docker Compose service inside Ubuntu. It only needs outbound network access and
does not publish an inbound port.

The chroot tutorial is a prerequisite; this document does not repeat its
rootfs installation or Android mount setup. In particular, install the BusyBox
NDK Magisk module (or use KernelSU's BusyBox), create the Ubuntu rootfs, and
confirm that the tutorial's normal Ubuntu launcher works before continuing.

> [!CAUTION]
> The chroot mounts can remain active after leaving Ubuntu. Follow the
> tutorial's warning: fully close Termux before deleting or moving the chroot,
> and never remove `/data/local/chroot/ubuntu` while it is mounted.

## Verify Docker inside Ubuntu

Enter Ubuntu using the launcher from the tutorial, then confirm that Docker and
the Compose plugin work:

```bash
docker info
docker compose version
docker run --rm alpine uname -m
```

Do not continue until all three commands succeed. Docker must run against the
Android kernel from the real chroot; a PRoot environment cannot provide the
required namespaces and cgroups.

The image uses the architecture reported by Docker, normally `linux/arm64` for
the Ubuntu ARM64 rootfs used by the tutorial.

## Check out and configure Shepherd

Run these commands inside Ubuntu after the deployment changes have been pushed:

```bash
cd /root
git clone https://github.com/triloy8/shepherd.git
cd /root/shepherd
```

If the checkout already exists, update it instead of cloning it again.

Create the runtime environment files if they do not exist:

```bash
cp envs/common.env.example envs/common.env
cp envs/discord.env.example envs/discord.env
chmod 600 envs/common.env envs/discord.env
```

Set `DISCORD_BOT_TOKEN` in `envs/discord.env`. For the first deployment, use
`CODEX_APPROVAL_POLICY=on-request` and `CODEX_SANDBOX=workspace-write`.

## Build and authenticate

Build the image:

```bash
docker compose build
```

Codex and GitHub CLI state live in named volumes. Authenticate them once:

```bash
docker compose run --rm shepherd codex login
docker compose run --rm shepherd gh auth login
```

An `OPENAI_API_KEY` or `GH_TOKEN` supplied through the environment can be used
instead of an interactive login. Do not add credentials to the image.

## Run

Start Shepherd in the background:

```bash
docker compose up -d
docker compose ps
docker compose logs -f shepherd
```

The service uses `restart: unless-stopped`. Docker restarts the container after
process failures and daemon restarts, unless the service was explicitly
stopped. Use `docker compose restart` for routine restarts. Avoid
`docker compose down` unless the container should be removed.

The named volumes preserve:

- Codex login and configuration
- GitHub CLI login and configuration
- Shepherd-created agent workspaces

The vendored skills directory is mounted read-only into the Codex home so skill
updates follow the checked-out Shepherd revision.

## Start manually inside Ubuntu

Run:

```bash
./deploy/ubuntu/start-shepherd.sh
```

The helper uses the existing daemon when available. Otherwise it first tries
the Ubuntu `service` command and then launches `dockerd` with `nohup`. Daemon
output is written to `/var/log/shepherd-dockerd.log`.

## Start from Termux:Boot

Install the Termux:Boot companion application from the same source as Termux,
open its launcher icon once, and allow both applications unrestricted battery
and background use.

The tutorial's `/data/local/chroot/start_ubuntu.sh` ends in an interactive shell
or desktop session, so it is not suitable for unattended boot. Create a
separate root-owned launcher at `/data/local/chroot/start_shepherd.sh` with the
following contents:

```sh
#!/system/bin/sh
set -eu

UBUNTUPATH=/data/local/chroot/ubuntu

mount_once() {
  if ! busybox mountpoint -q "$2"; then
    busybox mount --bind "$1" "$2"
  fi
}

busybox mount -o remount,dev,suid /data
mount_once /dev "$UBUNTUPATH/dev"
mount_once /sys "$UBUNTUPATH/sys"
mount_once /proc "$UBUNTUPATH/proc"

mkdir -p "$UBUNTUPATH/dev/pts" "$UBUNTUPATH/dev/shm" "$UBUNTUPATH/sdcard"
if ! busybox mountpoint -q "$UBUNTUPATH/dev/pts"; then
  busybox mount -t devpts devpts "$UBUNTUPATH/dev/pts"
fi
if ! busybox mountpoint -q "$UBUNTUPATH/dev/shm"; then
  busybox mount -t tmpfs -o size=256M tmpfs "$UBUNTUPATH/dev/shm"
fi
mount_once /sdcard "$UBUNTUPATH/sdcard"

exec busybox chroot "$UBUNTUPATH" /bin/bash -lc \
  'cd /root/shepherd && ./deploy/ubuntu/start-shepherd.sh'
```

Make it executable from the rooted Android shell:

```bash
su
chmod 700 /data/local/chroot/start_shepherd.sh
exit
```

Next, create the hook expected by Shepherd's Termux:Boot template at
`~/.shepherd-start-in-ubuntu`:

```bash
cat > ~/.shepherd-start-in-ubuntu <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
set -eu
exec su -c /data/local/chroot/start_shepherd.sh
EOF
chmod 700 ~/.shepherd-start-in-ubuntu
```

Finally, install the boot template from the Shepherd checkout. The checkout is
inside the chroot rootfs, so its Android-side path starts with
`/data/local/chroot/ubuntu`:

```bash
mkdir -p ~/.termux/boot
sudo cp /data/local/chroot/ubuntu/root/shepherd/deploy/termux/boot.example.sh \
  ~/.termux/boot/shepherd
sudo chown "$(id -u):$(id -g)" ~/.termux/boot/shepherd
chmod 700 ~/.termux/boot/shepherd
```

Test the complete Termux:Boot path before rebooting:

```bash
~/.termux/boot/shepherd
sleep 5
tail -n 100 ~/.cache/shepherd-boot.log 2>/dev/null || true
```

Then enter Ubuntu normally and verify the service:

```bash
cd /root/shepherd
docker compose ps
docker compose logs --tail=100 shepherd
```

The Termux layer acquires a wake lock, but Android may still terminate Termux
under memory pressure. Docker's restart policy only applies while the chroot
mounts and Docker daemon are available.

## Updating

From the Shepherd checkout inside Ubuntu:

```bash
git pull --ff-only
docker compose build
docker compose up -d --remove-orphans
docker image prune
```

Review changes before rebuilding, especially changes to `Dockerfile`,
`compose.yaml`, skills, and deployment scripts.
