# Surface launch and lifecycle

## Selection

`bun run start` launches `server/main.ts`. Store the selection in
`envs/common.env`, or supply it through the process environment:

```env
SHEPHERD_SURFACES=discord
```

An unset value defaults to Discord for existing installations. An explicitly
empty value, malformed name, duplicate, or unregistered surface is an error.
Only `discord` is registered today. The selection format can represent multiple
adapters; `discord,web` becomes valid only after a real web adapter is registered.
No placeholder web implementation or website hosting is included.

`bun run check:config` validates configuration without creating a runtime,
logging in, starting Codex, or opening a listener. It checks credential presence
and value syntax, not whether remote credentials are accepted. Setup supplies the
default in the common example; existing configuration is preserved. Changing
selection takes effect at the next host restart, not live.

## Configuration boundaries

Shared configuration comes from process variables and `envs/common.env`.
Common values are loaded into the process for Codex subprocesses. Each selected
adapter receives an isolated overlay from `envs/<name>.env`, with process/common
values taking precedence. Disabled adapter files are not read, validated, or
imported; adapter files cannot leak values into another adapter's configuration.

Runtime settings (including model, sandbox, signal listener and deployment
configuration) belong in common.env or the process environment. Adapter files
hold adapter settings only. Discord credentials are required only if Discord is
selected. There is no interactive menu during unattended startup.

## Runtime ownership

The host creates exactly one conversation/runtime owner, deployment lifecycle,
and signal runtime. Every adapter gets its own surface application context and
bound ingress/interaction capabilities. Conversation bindings are namespaced by
adapter and surface ID; navigation/listening state remains separate.

Existing exclusive thread binding is preserved: attempting to attach a thread
already active on another surface still fails. This change does not implement
shared-thread browsing or simultaneous cross-surface approvals. The future web
client will need a defined HTTP/event contract and access control over these
same application operations.

The host owns process signals, global restart/deploy, quiescing and final session
shutdown. An adapter exposes start, stop, and optional signal presentation; it
reports ready/degraded health through its context and receives a shutdown abort
signal. Adapter construction must not start network activity. Stop must release
partially started resources, tolerate repeated calls, and prevent pending startup
from reactivating the adapter after shutdown.

## Failure behavior

All selected configurations are validated before runtime creation. Adapters
start in selection order. If any selected adapter cannot start, or the shared
signal listener cannot bind, startup fails and cleans up all initialized
resources. The host does not silently ignore a failed selection.

After startup, an adapter disconnect reports degraded health and leaves the
other adapters and ongoing agent work running. Discord uses its SDK reconnect
behavior and reports recovery. An invalidated session reports that restart is
required. These are in-process isolation guarantees, not separate-process crash
isolation. There is no generic automatic adapter restart loop in this change.

Health transitions appear in host logs; the host also exposes a health snapshot
for integrations/tests. There is no new status endpoint or Discord command.
Signal notices go only to the adapter named by their delivery target. Presentation
failure is logged without discarding the underlying signal execution.

Shutdown first quiesces ingress and aborts pending adapter startup, then stops
the signal listener, closes adapters, and stops conversations. Cleanup continues
if an adapter stop fails; repeated stop requests share the same shutdown promise.
The external supervisor restarts the whole host after deployment or global
restart. Tailscale remains independently supervised.

## Validation and rollout

Tests exercise two synthetic adapters with shared runtime identity and separate
surface state, invalid configuration, partial startup failure, signal routing,
degraded/recovered health, and shutdown during pending login. The only production
transport remains Discord. Compiled and source entrypoints are the same launcher.

Merge and deploy through the normal Shepherd flow. Existing installations with
no selection configured continue using Discord. Do not configure `web` until
its adapter exists. No changes to shepherd-ui are required for this foundation.
