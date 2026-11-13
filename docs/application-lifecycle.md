# Application launch and shutdown

A launch succeeds when its requested files have been passed to the ready
document manager and its window has been shown. Receiving Electron's singleton
message is not completion. Requests received during boot must wait for boot.
Requests received during shutdown must wait for cleanup and transfer to the next
owner. Only one cleanup sequence may run, and no new document operation may
start after that sequence starts.

## Ownership and delivery

`ApplicationLifecycle` owns boot, the activation queue, and the shared shutdown
promise. Activation waits for boot and runs in order. Shutdown closes admission
to document operations, waits for any active operation, and shuts down services
once. Only then does it release the singleton lock and exit. Native open-file
and activation events use the same queue as command-line launches.

Electron's [singleton lock](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata)
elects the profile owner and delivers requests. `launch-request.ts` supplies the
application response through a loopback HTTP endpoint with a random path and a
kernel-assigned port. Both processes must implement this protocol.

| Response | Calling process |
| --- | --- |
| `ready` | Exit zero after the owner opens the documents and shows its window. |
| `retry` | Elect an owner again, after the previous owner finishes cleanup and releases the lock. |
| `error` | Report the failure and exit nonzero. |

An existing-instance-only request fails if the owner is stopping or absent.
A response timeout fails the launch. It does not authorize another instance.
Releasing the singleton lock before cleanup would permit concurrent profile
writes and is prohibited.

The desktop launcher waits for the application's completion message and a
mapped window. Concurrent desktop launches share a launcher lock so they cannot
overwrite each other's build or completion log. The application process does
not inherit that lock.

## Acceptance

Acceptance uses isolated profiles and real Electron processes. A suspended
primary must not make a secondary report success. Once the primary resumes,
the requested document must appear. Requests during cleanup must reach the
next owner, and repeated quit requests must share one cleanup operation.
Missing document paths must produce a nonzero caller exit.

Run `just test-e2e-file e2e/application-lifecycle.spec.ts` under Xvfb with
`TMPDIR` set to the repository's `.tmp` directory. The test uses the packaged
binary, which must be built from the source being checked.
