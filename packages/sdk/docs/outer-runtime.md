# Confining the Pi process

BYOS routes cooperating SDK consumers and the Pi tools wired through its facade.
Pi and peer extensions share a process and can use Node filesystem and process
APIs directly. Local MCP servers have their own process permissions. Remote MCP
servers run under the policy on their remote host.

To restrict Pi itself, launch it in a separately configured sandbox before
loading extensions. Configure filesystem and network access, credentials and
cleanup at that boundary. Local subprocesses must inherit the restrictions.

<!-- `outsideDestinations` and `outsideApproval` are provisional. -->

A BYOS provider can add isolation for individual operations. An outside
destination in the Pi process still runs within the outer sandbox. The user's
trusted host extension sets `outsideDestinations` and `outsideApproval` through
[`initialiseSandboxHost`][outside]. Those settings apply within the outer
boundary. Any route to the host beyond it requires authority from the outer
sandbox. Code in Pi continues to share access to the credentials and services
available to that process.

[outside]: api-protocol.md#outside-tool-and-review
