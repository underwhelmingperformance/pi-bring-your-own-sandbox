# Confining the Pi process

BYOS routes operations submitted through its SDK. It cannot confine peer
extensions, Pi's native file tools or MCP servers. Extensions execute in Pi's
process. A peer can call Node filesystem and process APIs without consulting
BYOS. A stdio MCP server inherits the process environment that Pi gives it; a
remote MCP server executes under its own host's security policy.

The [containment test][test] runs a real Pi 1.5.0 session with a scripted model,
a direct-reading extension and an actual stdio MCP server. A separate in-memory
SDK target returns a different marker. Both peers read the host marker even
while SDK operations use the target. On macOS the test repeats with the Pi
process started by `sandbox-exec`; a Seatbelt rule denies reads and writes to
that marker. Both peer reads then return permission denial, SDK target reads
still succeed, and the outer test independently verifies the host marker.

```sh
pnpm exec vitest run src/containment-integration.test.ts
```

Run the macOS case from an ordinary host terminal. An existing outer sandbox can
forbid another `sandbox_apply` operation. The Linux case verifies peer access;
the macOS case additionally verifies inherited Seatbelt denial. No model
credentials, live model requests, directory copies or replacement Pi algorithms
are involved.

The test profile allows other operations and denies only the controlled marker.
It demonstrates inherited restrictions. It is not a deployment profile, a
complete filesystem boundary or proof of descendant termination.

[test]: ../src/containment-integration.test.ts

## A separate launcher

A production launcher should start Pi inside the outer runtime before loading
any extension. Its own personal configuration selects that runtime and its
policy. Project configuration must not select or weaken the outer runtime. The
launcher is separate from BYOS: an inner SDK provider can still implement
additional remote or per-operation isolation.

The launcher needs its own integration work before use:

1. Construct a deny-by-default filesystem policy. Expose the workspace with
   explicit access, read-only runtime files and private scratch/state storage.
   Exclude host homes, credentials, daemon sockets, resolver sockets and
   unrelated workspace aliases. Protect configuration that host software later
   executes, or use a copy with a separate reviewed publication step.
2. Define credentials and model access. A credential file readable by Pi is
   readable by every loaded extension. A host credential broker can avoid
   exposing credential bytes, but its protocol must restrict destinations and
   operations. Granting a generic HTTP, socket or command relay defeats that
   restriction. Model egress remains an explicit outer-runtime permission.
3. Transport the terminal or RPC UI over inherited stdio. Authenticate and bound
   any approval channel across the boundary. Give the user enough request and
   destination information to decide. Treat sandbox-provided display text as
   untrusted. A disconnected UI cannot imply approval.
4. Start stdio MCP servers inside Pi's containment and verify subprocess
   inheritance independently. Remote MCP servers need their own isolation and
   trust policy. Host-launched MCP services and arbitrary host sockets must not
   become implicit grants.
5. Decide outside execution separately. Pi's native outside route is still
   inside the outer runtime. Host execution requires an explicit, authenticated
   gateway with a host-side approval policy and bounded operations. An inner
   BYOS approval does not itself authorise escape from the launcher.
6. Use runtime-specific allocation and termination guarantees. Seatbelt access
   restrictions continue across `setsid()`, but process-group cancellation does
   not stop every descendant. A contained Linux PID namespace or container can
   provide a stronger scope only after independent cleanup tests establish it.
   Preserve unknown termination and recovery information on failure.

Test the complete arrangement with host-only and target-only markers, peer
filesystem and process APIs, stdio MCP, denied sockets, approved model access,
credential handling, shutdown and intentionally approved outside execution.
Untrusted extensions within Pi can still interfere with Pi and each other; outer
containment limits host access, not the authority of code inside that process.
Runtime exploits, exposed host services and user-approved publication remain
separate trust assumptions.

This investigation establishes the need for an outer process boundary and a
small native inheritance demonstration. It does not add a launcher to the SDK or
claim that replacement tool registration confines extensions.
