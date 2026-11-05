# Confining the Pi process

BYOS routes operations submitted through its SDK. It cannot confine Pi's native
file tools, peer extensions or MCP servers. Extensions execute in Pi's process
and can call Node filesystem and process APIs directly. Local MCP servers have
the permissions of their process; remote MCP servers have their own host's
security policy.

To restrict the whole process, start Pi inside a separately configured sandbox
before loading extensions. Local subprocesses must inherit those restrictions.
The outer sandbox needs its own filesystem, network, credentials and cleanup
policy. BYOS does not provide a launcher or configure that boundary.

An inner BYOS provider can supply additional remote or per-operation isolation.
Pi's normal outside-execution destination remains inside the outer sandbox.
Executing on the host requires a separately authorised route through the outer
boundary; BYOS approval alone does not grant that access.

Code inside Pi still shares access to Pi's readable credentials and permitted
services. Outer containment restricts host access but does not isolate
extensions from Pi or from each other.
