# Design principles

These principles guide the design of the SDK, its Pi integration, and the
providers and consumers built on it, including those in other repositories. The
[specification][spec], the [API and protocol appendix][api] and the [conformance
suite][testing] follow from them. Terms with a specific meaning link to the
[glossary](#glossary).

If the code or another document contradicts a principle, that is a defect. To
depart from a principle, change this document first, in its own commit, and give
the reason.

Each principle states the rule, explains why it exists, and lists how the system
enforces it.

[spec]: specification.md
[api]: api-protocol.md
[testing]: provider-testing.md

## 1. The system enforces the rules

Every rule in the contract is enforced by code: by the types, by a runtime
check, by the conformance suite, or by a repository check such as lint. A rule
that is only written down is a defect, so enforce it or delete it. Where
possible, make the wrong thing impossible to write. Otherwise, detect it
automatically. Rely on review only when neither is possible.

BYOS connects code written by different people, released at different times, in
different repositories. Someone who never read a written rule will eventually
break it, and if nothing checks the rule, nobody notices until a user is
affected.

In practice:

- Each concept is defined once. The runtime schemas are the definition, and the
  TypeScript types are derived from them.
- The broker and the conformance suite use the same checks, so a provider passes
  the suite exactly when the broker accepts it.
- Behaviour never depends on a provider ID or on spotting a particular
  combination of settings. If a behaviour matters, the contract has a field for
  it.
- Every fixed list of values, such as the capabilities and the error names, is
  handled exhaustively. Adding a value does not compile until the value is
  handled and tested.

## 2. Give each caller only what it needs

Each API gives its caller the smallest operation that does the job. A reviewer
can make copies of one [destination]. A permission extension can decide the
escalation of one pending tool call. Only the host that started a session can
close it.

A caller that can do only one thing cannot misuse anything else, by mistake or
otherwise. BYOS runs inside Pi with the same permissions as every other
extension, so it cannot stop an extension from going around it. That limits what
BYOS can prevent. It is not a reason to give callers more than they need.

Enforced by:

- frozen objects that contain only the permitted methods;
- handle and identity types that callers cannot construct;
- separate entry points for each audience (principle 11).

[destination]: #destination

## 3. Consumers state what they require, not how to configure the sandbox

A [consumer] uses an [access record] to state [needs][need],
[restrictions][restriction] and [path grants][path grant]. It never sets
[policy] values. A property that the consumer leaves out gets as much access as
the [configured policy] and the provider allow, so a consumer without special
requirements passes nothing.

[Acquisitions][acquisition], [copies][copy] and [escalations][escalation] use
the same access record and the same [negotiation rule][negotiation].

A consumer knows what it requires but not what each provider can do. If
consumers set policy values, each consumer would have to understand every
provider, and could easily receive more access than it intended to request. With
one record and one rule, a request gets the same answer on every path.

Enforced by:

- option types that have no policy fields;
- one access record for ordinary requests and escalation;
- conformance cases for every property state, path grants and profile ranking.

[consumer]: #consumer
[access record]: #access-record
[restriction]: #restriction
[need]: #need
[path grant]: #path-grant
[policy]: #policy
[acquisition]: #acquisition
[copy]: #copy
[configured policy]: #configured-policy
[negotiation]: specification.md#configuration-and-negotiation
[escalation]: #escalation

## 4. A requirement changes only what it is about

Asking for a restriction or a need changes only that property of the sandbox.
Setting `network: 'prevented'`, for example, removes network access and nothing
else. Anything else that a consumer depends on, such as working directly on the
user's files, is a need of its own.

When one requirement quietly changes something unrelated, the consumer receives
a sandbox that differs from what it expects, and no error tells it so. A
provider that can share the user's files only while the network is enabled must
therefore reject a request for both. It must not hand out a private copy
instead, because the consumer would then act on files that the user and the
model cannot see.

Enforced by:

- a mapping from each restriction and need to exactly one policy setting;
- conformance cases that open a sandbox with and without each requirement and
  check that only the related property differs.

## 5. BYOS knows whether a request can work before it starts anything

A provider describes what it supports as a list of [profiles][profile]. Each
profile is a combination of policy settings that the provider can actually
provide together, with the capabilities that work under it. Copies have their
own list, because a provider often copies under different conditions from those
under which it opens a sandbox.

BYOS chooses a profile before it starts anything. When `client.negotiate` says
that a request is supported, acquiring that sandbox can fail only for a runtime
reason, such as a stopped daemon. After starting a [backend], BYOS checks that
it matches the chosen profile and rejects it otherwise.

A separate list of supported values for each setting assumes that every
combination works, and real providers do not work that way. When BYOS cannot
tell in advance, it starts a container or virtual machine, discovers that the
result is unsuitable, tears it down and reports the problem late. Consumers also
cannot ask whether a request would work without trying it.

Enforced by:

- profile types, and negotiation that reads only profiles;
- the check after a backend starts;
- conformance cases for every profile that a provider declares.

[profile]: #profile
[backend]: #backend

## 6. Check claims with their source

Information from another extension or another SDK copy is checked for shape when
it arrives, but its shape proves nothing about isolation. A claim about a
sandbox, for example that a copy has no network access, is accepted only from
the [broker] that the caller found itself, never from the object that makes the
claim. Messages between extensions therefore contain identities, and the
receiver looks each identity up through its own broker.

Any extension can answer a message on Pi's event bus. If a consumer believed an
object's description of itself, any extension could give it a fake sandbox that
claims to be isolated and runs commands anywhere.

Enforced by:

- schemas at every boundary;
- reply types that contain identities and never sandbox objects;
- tests that send forged replies.

[broker]: #broker

## 7. One protocol, changed only by addition

SDK copies communicate through one protocol: a small, fixed set of channels with
one message format. The protocol version has two parts, a major number and a
feature level. Each SDK build implements exactly one major number and one
feature level.

Within a major number, the protocol changes only by addition. A new optional
field, a new value in a list and a new method each raise the feature level, and
the schema records the level that introduced each addition. Any other change,
such as removing or renaming a field or changing the meaning of a value, starts
a new major number. Builds with different major numbers do not work together.
Discovery fails, and the error identifies both builds and the extensions that
loaded them.

Two builds with the same major number use the lower of their feature levels, and
nothing above that level passes between them. When a message uses a feature
above the shared level, the kind of message decides the outcome:

- An offer, such as a provider's list of profiles, leaves out what the receiver
  cannot understand. Offering less is always safe.
- A demand, such as a consumer's restriction, fails with an error that
  identifies the extension to update. Dropping a requirement would weaken
  isolation.

The broker and the other shared services are created only after every extension
has loaded, by the loaded build with the highest feature level.

Each Pi package bundles its own copy of the SDK, so one session often contains
several builds released months apart. Updating one package must not break the
others, and an older build must never silently drop a requirement that it does
not understand.

Enforced by:

- feature-level annotations on the schemas, from which the SDK generates the
  checks for any level, so reducing a message to a lower level is mechanical;
- a committed snapshot of the protocol schemas, and a test that fails unless a
  change to them is an addition that raises the feature level or the change
  raises the major number;
- a compatibility test that runs the first build of the current major number
  against the current build, as both provider and consumer;
- the build identity, major number and feature level in every advertisement and
  in `/byos status`.

## 8. Never lower isolation without a decision, and say what to fix

When something cannot work, BYOS stops and reports why. An API that cannot do
what was asked returns a reason. An ordinary operation never moves to the host
after failure. An [escalation] may choose the host before the command starts.
The decision describes the host's lack of restrictions before either a
permission extension or the user can allow it.

Errors say which requirement failed, with which value, and which extension or
provider to look at, without revealing configuration values. Text from a model,
a provider or another extension is cleaned before the user sees it, so it cannot
contain terminal control sequences.

A user who chose a sandbox expects commands to run in it, and a silent fallback
breaks that without telling them. An error that does not say what to change
leaves the user guessing, and a user who has to guess is likely to turn the
sandbox off.

Enforced by:

- error types that require the detail;
- results that include a reason;
- a display text type that only the cleaning function produces and that every
  user interface call requires.

## 9. The outcome depends only on configuration and requests

Given the same configuration and the same requests, BYOS behaves the same way.
Nothing that the user cannot see or control changes the result. That includes
the order in which Pi loads extensions, which SDK copy starts first, the timing
between events, and where a package is installed.

Users cannot diagnose behaviour that depends on things that are hidden from
them. If installing packages in a different order silently disables a feature,
nobody will connect the cause with the effect.

Enforced by:

- no module state that depends on which copy loaded first;
- shared services created at a defined point by a defined build (principle 7);
- tests that vary the load order and the order of SDK copies and expect the same
  results.

## 10. Each escalation is decided once

BYOS asks the user to confirm an escalation unless a [permission extension] has
recorded a decision for the pending call. Either decision applies to one tool
call ID and to the negotiated destination and restrictions for that call. The
configuration can prohibit escalation before any prompt.

A permission extension can review the same command and destination that the user
would see. Reusing the recorded verdict avoids a second prompt or a
contradictory decision.

Enforced by:

- an operation that records one escalation decision for a pending tool call;
- integration tests that verify the requested and executed destinations and
  count the prompts with and without a recorded decision.

[permission extension]: #permission-extension

## 11. A small surface, split by audience

Each audience has its own entry point: consumers, providers, the embedding host,
reviewers, the Pi tool integration and the test kit. Nothing is exported unless
someone in that audience uses it. Message formats and channel names stay
internal.

Every capability in the contract has a consumer that uses it. A capability
without one waits until a consumer exists.

Everything exported has to stay compatible (principle 7), so each export is a
cost for as long as it exists. Adding to the contract later is cheap, and
removing something after release is not. Mixing audiences in one entry point
also gives callers operations meant for someone else, such as letting any
consumer close the user's session.

Enforced by:

- the package `exports` map;
- a committed report of the public API, which changes only when a change intends
  it to;
- knip;
- lint rules for import boundaries, so the Pi integration uses only the public
  entry points.

## 12. Shared work belongs in the SDK, and isolation belongs to providers

A provider implements only what is specific to its isolation technology:
starting and stopping the isolated environment, giving it the workspace, and
running a process inside it.

When two providers would otherwise write the same mechanism, the SDK provides it
once. Examples are encoding argument lists for a shell, supervising process
groups, the file and search helpers that run inside the sandbox, mapping
operating system errors, cleanup time limits, and starting a provider extension.

When two providers write the same mechanism, they write it differently, and
consumers get different results depending on the provider. Each provider author
also has to rediscover the same edge cases.

Enforced by:

- a provider contract that contains only the isolation-specific operations;
- the SDK's provider kit;
- conformance cases that check that consumers get the same file and search
  results from every provider.

## 13. The conformance suite defines a correct provider

A provider is correct when it passes the conformance suite. The suite runs the
provider through the real broker. It covers every capability and profile that
the provider declares, including copies, and it tests cancellation, cleanup
after a failed start, and recovery. Provider repositories run the suite in their
own CI.

A provider author should find their bugs by running the suite, not when users
hit them. If the suite and the broker disagree about a provider, one of them is
wrong.

Enforced by:

- cases generated from the provider's declaration, so a declared capability
  without cases fails;
- exhaustive handling of the capability list (principle 1).

## 14. Promise only what a consumer needs

The contract promises a property only when a consumer would behave differently
without it. Atomic copies, ordering between operations, and protection of
particular files, such as `.git` or Pi's extension directories, are examples of
properties that no consumer currently needs. Providers may still offer such
properties through their own configuration.

Every promise in the contract has to be implemented by every provider and tested
by the suite. A promise that nobody relies on costs every provider and benefits
nobody.

Enforced by the specification, which lists the consumer that relies on each
promise. A promise without a consumer is removed.

## 15. One name for each concept

Each concept has one term, used with the same meaning in code, documentation,
errors and the user interface. Code identifiers use the same words as the
glossary.

When one concept has several names, readers assume that the names refer to
different things.

Enforced by the glossary and by a documentation check that rejects retired
terms.

## 16. Users install and configure their sandbox provider

Users install and configure their sandbox provider. Every user setting belongs
in the provider's own settings file. Users see BYOS only in diagnostics.

A user chooses a sandbox. A second configuration surface gives users two places
to look and two sets of terms to learn.

Enforced by:

- [shared settings keys][shared settings] that the SDK defines once and exposes
  through provider registration;
- a conformance check that the provider accepts and validates the shared keys.

[shared settings]: #shared-settings-keys

## 17. Record every decision that changes isolation

Record each decision that changes isolation in the session's [ledger]. The
record identifies who made the decision and what happened. If the call ends
before anyone decides, record the outcome.

Users need to see why a command ran with more access. Reviewers need to relate
review copies and reported violations to the tool call that produced them.

Enforced by:

- typed Pi session entries from one ledger schema;
- an integration test that verifies an entry for every escalation path.

[ledger]: #ledger

## Glossary

### Access record

The consumer's needs, restrictions and path grants. Omitted properties use the
configured policy within the provider's support.

### Acquisition

Asking the broker for a sandbox with `client.get`.

### Backend

One running isolated environment that a provider started, with one policy.

### Broker

The shared service that finds providers, chooses profiles and manages the
backends for a Pi session.

### Configured policy

The user's access limit and the default for ordinary requests. An escalation may
exceed it when the configuration permits escalation and a decision allows the
request.

### Consumer

An extension that uses sandboxes, through acquisition or through a review
source.

### Copy

A sandbox with its own files, which start as a copy of another sandbox's files
or of the user's files. Changes stay in the copy.

### Destination

Where a shell tool call runs. It can run in the provider's sandbox, with or
without extra access, or on the host.

### Escalation

An explicit request for extra access on one shell tool call. It needs a decision
for that call before execution.

### Feature level

The revision within one protocol major number. Each addition raises this number.

### Generation

The backends that one provider runs for one Pi session.

### Host system files

Files installed and maintained for the host operating system or a system-wide
runtime, such as OS binaries in `/bin` or `/usr/bin`, machine configuration in
`/etc` and macOS system files in `/System`.

### Host user data

Host files outside the checkout and outside the host system files. This includes
user data in system-managed directories.

### Ledger

The typed decision records in a Pi session. Entries describe escalations, review
copies and provider-reported violations.

### Need

Access without which a consumer cannot work. The consumer marks the property
`needed` in the access record.

### Path grant

A request for read or write access to a particular path. An ordinary request can
require only access within the configured policy.

### Permission extension

An extension that decides whether a tool call may run, for example by asking the
user or by having a model review the call.

### Policy

The settings that control what a sandbox can reach: the workspace, the rest of
the filesystem, and the network.

### Profile

A combination of policy settings that a provider can provide together, with the
capabilities that work under it.

### Provider

An extension that registers with the broker and starts backends.

### Provider kit

The shared SDK helpers that providers use to implement backend operations.

### Restriction

Access that a sandbox must prevent. The consumer marks the property `prevented`
in the access record.

### Review route

The exchange that identifies a pending tool call's review source or reports why
it is unavailable.

### Review source

What a permission extension receives for one pending tool call. It can make
copies of that call's destination and do nothing else.

### Sandbox

The object that a consumer uses to run commands and file operations in a
backend.

### Shared settings keys

The keys that the SDK defines for settings common to all providers. Each
provider includes them in its own settings parser.

### Workspace

The directory tree that a sandbox works in, normally the user's project.
