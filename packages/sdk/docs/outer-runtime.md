# Confining the Pi process

BYOS routes cooperating SDK consumers and the Pi tools wired through its facade.
Pi and peer extensions share a process and can use Node filesystem and process
APIs directly. Local MCP servers have their own process permissions. Remote MCP
servers run under the policy on their remote host.

To restrict Pi itself, launch it in a separately configured sandbox before
loading extensions. Configure filesystem and network access, credentials and
cleanup at that boundary. Local subprocesses must inherit the restrictions.

<!-- `allowEscalation` is provisional. -->

A provider can isolate individual operations within the outer sandbox. If an
[escalation][escalation] selects the host, the workload still runs inside the
outer sandbox. The provider's `allowEscalation` setting governs access within
that boundary. Access beyond the outer sandbox requires authority from that
sandbox. Code in Pi shares the credentials and services available to the Pi
process.

[escalation]: specification.md#escalation
