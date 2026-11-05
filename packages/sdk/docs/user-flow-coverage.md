# Integration coverage of user flows

This guide maps the framework's supported entry points and user-visible outcomes
on Pi 1.5.0 to integration tests. Unit and provider contract tests add checks
for individual operations and malformed protocol values; they do not replace the
integration cases below.

Run the framework and CLI/RPC cases with `pnpm test:integration`. Run the
archive installation and real Docker cases separately with `pnpm test:package`
and `pnpm test:provider`. The [development guide][validation] describes the
prerequisites, commands and platform limits.

[validation]: validation.md

## Installation and configuration

| User flow                                                                                                  | Integration evidence                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install a consumer without configuring a sandbox or loading the diagnostic extension.                      | [Client integration][client] acquires default passthrough, performs host file operations and shares startup across SDK copies.                                                                                                |
| Select a provider, or leave an installed provider unselected.                                              | [Client integration][client] verifies configured target operations, idle unselected providers and missing/startup-failed providers without host fallback.                                                                     |
| Use extension-owned settings while a project contains conflicting selector files.                          | [Approval RPC integration][approval-rpc] starts Pi with conflicting project settings and verifies that extension activation and user approval still apply.                                                                    |
| Supply invalid extension configuration.                                                                    | [Client integration][client] verifies that obsolete selector files are ignored and checks invalid declarations in a real Pi runtime. Approval RPC cases check invalid built-in policy configuration and missing policy IDs.   |
| Load separate provider, policy and consumer extensions in any order, including separate SDK installations. | [Registration integration][registration] checks all six factory orders across independent SDK module graphs. The [archive gate][package] installs two independent package roots and exercises approval and outside execution. |
| Embed Pi with an explicit agent directory or a different normal execution environment.                     | Client integration checks independent bound directories and rejected late/repeated bindings. [Outside execution integration][outside] uses an injected normal executor and verifies its destination and cleanup.              |

[client]: ../src/client-integration.test.ts
[approval-rpc]: ../src/approval-rpc-integration.test.ts
[registration]: ../src/registration-integration.test.ts
[package]: ../src/package.test.ts
[outside]: ../src/outside-execution-integration.test.ts

Registration integration also checks shell-only providers, unavailable exit
details, required argv or guaranteed status, and effective cleanup budgets
across independent SDK copies. Pi shell integration verifies that unavailable
status preserves output and reports a failed command.

## Execution and approval

| User flow                                                                                | Integration evidence                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run ordinary Bash or PowerShell tools in the selected sandbox.                           | [Pi shell integration][shell] uses real model dispatch and provider operations, including direct and nested calls, tool selection and result transforms.                                                                                                      |
| Run a user shell command, include or exclude its transcript, or cancel cold startup.     | [User-shell integration][user-shell] and [user-shell RPC][user-rpc] exercise the public event and actual CLI transport. [Default user-shell integration][default-shell] runs without sandbox configuration.                                                   |
| Request outside execution on the normal or provider-defined destination.                 | Approval RPC integration covers SDK argv execution and native Bash, plus provider Bash and PowerShell. Marker files and backend journals verify dispatch and the absence of ordinary sandbox allocation.                                                      |
| Approve, deny or dismiss the built-in user dialogue.                                     | Approval RPC integration exchanges actual `extension_ui_request` and `extension_ui_response` packets. It checks destination, policy description, cwd, command and justification, and verifies effects only after approval.                                    |
| Review a request with explicit environment overrides.                                    | The RPC dialogue includes override keys and excludes their values. SDK integration verifies the exact reviewed request; provider tool requests exclude inherited host environment.                                                                            |
| Use the user policy in a runtime without a dialogue UI.                                  | [Approval service integration][approval-service] verifies `ApprovalUnavailableError` without sandbox allocation.                                                                                                                                              |
| Select always, never or an extension-provided policy.                                    | Outside execution integration and RPC cases verify built-in decisions and configured-policy failures. [Scripted approver integration][approver] uses separate parent and reviewer models through a real Pi runtime.                                           |
| Request another operation after approval or denial, or reply to an expired request.      | RPC cases require a fresh confirmation after approval or denial. Late replies cannot approve subsequent invocations or execute an expired operation.                                                                                                          |
| Queue approval requests, let one expire, or cancel a pending request.                    | RPC cases verify serial dialogues, expiry without a second dialogue, caller cancellation, model abort and ignored late allow responses. Outside execution integration also checks deterministic deadlines with controlled promises.                           |
| Apply a Bash command prefix.                                                             | RPC cases compare the complete reviewed and dispatched prefixed command on normal and provider destinations. Pi shell integration checks prefix effects on ordinary sandbox execution.                                                                        |
| Omit the outside justification or supply one on the ordinary route.                      | RPC model-tool cases return the typed request error before prompting or execution.                                                                                                                                                                            |
| Encounter missing capabilities, failed outside allocation or failed execution.           | Outside execution integration covers missing outside capabilities and acquisition requirements. RPC cases verify typed allocation/execution failures with no switch to normal execution.                                                                      |
| Receive streamed or large output, cancellation, deadline expiry or uncertain completion. | Pi shell integration checks retained diagnostic output and Pi's full-output files. Outside tool integration checks native timeout output and prevents dispatch after configuration expiry. User-shell and SDK suites cover unknown completion and quarantine. |
| Use SDK file and search operations from a consumer.                                      | Client and [consumer example integration][consumer] operate through shared SDK capabilities and remote provider fixtures. These calls do not enable Pi file/search tool routing.                                                                              |

[shell]: ../src/pi-tools-integration.test.ts
[user-shell]: ../src/user-shell-integration.test.ts
[user-rpc]: ../src/user-shell-rpc.test.ts
[default-shell]: ../src/user-shell-passthrough-integration.test.ts
[approval-service]: ../src/execution-approval-integration.test.ts
[approver]: ../src/pi-tools-outside-integration.test.ts
[consumer]: ../examples/consumer/test/integration.test.ts

## Session lifecycle and diagnostics

| User flow                                                                 | Integration evidence                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Close the SDK while approval is pending, or quit Pi with a dialogue open. | RPC cases exercise explicit SDK close and actual process shutdown. They verify cancellation before dispatch and ignore subsequent allow responses.                                                             |
| Start a new session or reload extensions.                                 | RPC session replacement cancels the old user confirmation and requests a new decision. [Broker integration][broker] checks reload, new generations and stale services.                                         |
| Shut down after a transport failure or unconfirmed termination.           | Outside execution and [diagnostic integration][diagnostics] verify incomplete cleanup reports, recovery and blocked reuse. Cleanup continues if another service fails to close.                                |
| Inspect status, enumerate providers/policies or request command usage.    | Diagnostic integration checks all commands without allocation or a model turn. RPC cases also report an unavailable selected approval policy, enumerate an extension policy and exclude configuration secrets. |
| Run against the reference isolation backend.                              | The [Docker session suite][docker] checks real target effects, model Bash dispatch, cancellation of descendants, session separation and cleanup.                                                               |

[broker]: ../src/broker-integration.test.ts
[diagnostics]: ../src/diagnostics-integration.test.ts
[docker]: ../examples/docker/test/session.test.ts

The [cleanup integration suite][cleanup] exercises cancellation and disposal
under configured budgets on sandboxed, normal outside and provider-defined
outside destinations. It checks extension-owned selection and the deadlines
visible to providers. Diagnostic integration verifies that ordinary and outside
provider warnings appear through generic status without entering workload output
or allocating the ordinary sandbox.

[cleanup]: ../src/cleanup-integration.test.ts

## Transport and platform boundaries

RPC approval uses Pi's actual confirmation implementation without replacing
`context.ui.confirm`. The parent model and remote execution backend are local
fixtures. The suite requires no model credentials or external reviewer service.

Terminal drawing, keyboard navigation and literal interactive `!`/`!!` parsing
are Pi-owned paths and have no terminal automation in this repository. Their
framework execution and approval boundaries are exercised through real Pi
contexts and RPC. Native PowerShell execution depends on an installed PowerShell
runtime; the automated approval cases use a provider with that dialect.

Pi file/search tool routing, host full-output references and native shell
background-process cleanup retain the limits in the [Pi coverage table][pi]. The
framework does not implement replacement Pi algorithms for those paths. The
tests do not claim confinement of arbitrary extension code or Windows host
process-tree support.

[pi]: pi-integration.md

Termination-scope integration exercises cancellation without a guarantee on the
ordinary sandbox and both outside destinations. It checks immediate
cancellation, continued use after a late provider failure, rejected workload
requirements and independent allocation disposal. Registration integration
checks scope requirements and structural cancellation errors across independent
SDK copies. The passthrough tests include a waiting parent whose child starts a
new session; the child remains outside the declared process-group scope.

The real Docker conformance and SDK session tests use a waiting parent with a
child in a new POSIX session. They verify workload cancellation for caller
abort, expiry and output-callback failure through independent container checks.
