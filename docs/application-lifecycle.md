# Application launch and shutdown

A launch succeeds when its requested files have been passed to the ready
document manager and its window has been shown. Receiving Electron's singleton
message is not completion. Requests received during boot must wait for boot.
Requests received during shutdown must wait for cleanup and transfer to the next
owner. Only one cleanup sequence may run, and no new document operation may
start after that sequence starts.

## Evidence and acceptance

The application log on 2026-10-31 records shutdown at 04:40:48, a second-instance
request at 04:40:52, and completion of cleanup at 04:41:08. `main.ts` dispatches
that request because the service container still reports `isBooted`. Before
boot, the same handler returns without retaining the request. Repeated
`will-quit` events each call `shutdownApplication` until its first promise
resolves. These are independent consequences of the missing lifecycle owner.

Electron documents singleton lock acquisition as message delivery, not an
application response: <https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata>.
Releasing that lock before cleanup finishes would permit concurrent profile
writes. The lock must remain held throughout cleanup.

Acceptance uses isolated profiles and real Electron processes. A suspended
primary must not make a secondary report success. Once the primary resumes,
the requested document must appear. Requests during cleanup must reach the
next owner, and repeated quit requests must share one cleanup operation.
