import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("deploy/ubuntu/tailscale.sh");
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "shepherd-tailscale-"));
  const bin = join(home, "bin");
  const state = join(home, ".local/state/tailscale");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const installed = join(home, `.local/lib/tailscale/tailscale_1.102.4_${arch}`);
  mkdirSync(installed, { recursive: true });
  const executable = (path: string, body: string) => writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  executable(join(bin, "tmux"), 'echo "$*" >> "$HOME/tmux.calls"; [[ "$1" != has-session ]]');
  executable(join(installed, "tailscale"), 'echo "$*" >> "$HOME/cli.calls"; exit 0');
  executable(join(installed, "tailscaled"), 'exit 0');
  return {
    home, state, bin, installed, executable,
    run: (...args: string[]) => Bun.spawnSync(["bash", script, ...args], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } }),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("optional startup does nothing until enabled", () => {
  const f = fixture(); try {
    expect(f.run("start").exitCode).toBe(0);
    expect(existsSync(join(f.home, "tmux.calls"))).toBe(false);
  } finally { f.cleanup(); }
});
test("enabled startup creates independent supervisor without changing network preferences", () => {
  const f = fixture(); try {
    writeFileSync(join(f.state, "enabled"), "");
    expect(f.run("start").exitCode).toBe(0);
    expect(readFileSync(join(f.home, "tmux.calls"), "utf8")).toContain("new-session -d -s shepherd-tailscale");
    expect(existsSync(join(f.home, "cli.calls"))).toBe(false);
  } finally { f.cleanup(); }
});
test("repeated startup leaves existing session alone", () => {
  const f = fixture(); try {
    writeFileSync(join(f.state, "enabled"), "");
    f.executable(join(f.bin, "tmux"), 'echo "$*" >> "$HOME/tmux.calls"; exit 0');
    expect(f.run("start").exitCode).toBe(0);
    expect(readFileSync(join(f.home, "tmux.calls"), "utf8")).not.toContain("new-session");
  } finally { f.cleanup(); }
});
test("disable preserves identity and removes startup opt-in", () => {
  const f = fixture(); try {
    writeFileSync(join(f.state, "enabled"), "");
    writeFileSync(join(f.state, "tailscaled.state"), "saved identity");
    expect(f.run("disable").exitCode).toBe(0);
    expect(existsSync(join(f.state, "enabled"))).toBe(false);
    expect(readFileSync(join(f.state, "tailscaled.state"), "utf8")).toBe("saved identity");
  } finally { f.cleanup(); }
});
test("checksum failure cannot enable installation or overwrite existing identity", () => {
  const f = fixture(); try {
    f.executable(join(f.bin, "curl"), 'if [[ "$*" == *sha256 ]]; then printf "%064d" 0; else while [[ "$1" != -o ]]; do shift; done; echo corrupt > "$2"; fi');
    writeFileSync(join(f.state, "tailscaled.state"), "saved identity");
    expect(f.run("install").exitCode).not.toBe(0);
    expect(existsSync(join(f.state, "enabled"))).toBe(false);
    expect(readFileSync(join(f.state, "tailscaled.state"), "utf8")).toBe("saved identity");
  } finally { f.cleanup(); }
});
test("explicit login uses the private socket and disables DNS and route acceptance", () => {
  const f = fixture(); try {
    writeFileSync(join(f.state, "enabled"), "");
    expect(f.run("login").exitCode).toBe(0);
    const calls = readFileSync(join(f.home, "cli.calls"), "utf8");
    expect(calls).toContain(`--socket=${f.state}/tailscaled.sock up --hostname=shepherd-host --accept-dns=false --accept-routes=false --timeout=60s`);
  } finally { f.cleanup(); }
});
test("supervisor restarts a failed daemon and exits when disabled", () => {
  const f = fixture(); try {
    writeFileSync(join(f.state, "enabled"), "");
    f.executable(join(f.installed, "tailscale"), "exit 1");
    f.executable(join(f.bin, "sleep"), "exit 0");
    f.executable(join(f.installed, "tailscaled"), 'echo "$*" >> "$HOME/daemon.calls"; if [[ $(wc -l < "$HOME/daemon.calls") -ge 2 ]]; then rm "$HOME/.local/state/tailscale/enabled"; fi; exit 1');
    expect(f.run("run").exitCode).toBe(0);
    const calls = readFileSync(join(f.home, "daemon.calls"), "utf8").trim().split("\n");
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("--tun=userspace-networking");
    expect(calls[0]).toContain(`--statedir=${f.state}`);
  } finally { f.cleanup(); }
});
test("supervisor does not replace a reachable daemon even before login", () => {
  const f = fixture(); try {
    writeFileSync(join(f.state, "enabled"), "");
    f.executable(join(f.installed, "tailscaled"), 'touch "$HOME/unexpected-daemon"');
    f.executable(join(f.bin, "sleep"), 'rm "$HOME/.local/state/tailscale/enabled"');
    expect(f.run("run").exitCode).toBe(0);
    expect(existsSync(join(f.home, "unexpected-daemon"))).toBe(false);
  } finally { f.cleanup(); }
});
