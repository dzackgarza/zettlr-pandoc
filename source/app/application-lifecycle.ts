import errorToString from "@common/util/error-to-string";
import type { LaunchOutcome } from "./launch-request";

type Phase = "booting" | "running" | "stopping" | "stopped" | "failed";
interface Activation {
  files: string[];
  complete: (outcome: LaunchOutcome) => Promise<void>;
}
interface LifecycleOperations {
  boot: () => Promise<void>;
  open: (files: string[]) => Promise<void>;
  shutdown: () => Promise<void>;
  release: () => void;
  quit: () => void;
  report: (error: Error) => void;
  fail: (error: Error) => void;
}

/** One owner orders boot, document activation, and cleanup. Electron readiness
 * and a constructed service container are not application lifecycle states.
 */
export class ApplicationLifecycle {
  private phase: Phase = "booting";
  private readonly pending: Activation[] = [];
  private readonly booted: Promise<void>;
  private draining: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | undefined;

  constructor(private readonly operations: LifecycleOperations) {
    this.booted = operations.boot().then(() => {
      if (this.phase === "booting") {
        this.phase = "running";
        this.drain();
      }
    });
    void this.booted.catch(async (error: Error) => {
      this.phase = "failed";
      await this.finishPending({
        status: "error",
        message: errorToString(error),
      });
      operations.fail(error);
    });
  }

  activate(files: string[], complete: Activation["complete"]): void {
    switch (this.phase) {
      case "booting":
      case "running":
      case "stopping":
        this.pending.push({ files, complete });
        if (this.phase === "running") this.drain();
        return;
      case "stopped":
        void complete({ status: "retry" }).catch(this.operations.report);
        return;
      case "failed":
        void complete({
          status: "error",
          message: "Application boot failed",
        }).catch(this.operations.report);
    }
  }

  private drain(): void {
    this.draining = this.draining.then(async () => {
      while (this.phase === "running" && this.pending.length > 0) {
        const request = this.pending.shift()!;
        let outcome: LaunchOutcome;
        try {
          await this.operations.open(request.files);
          outcome = { status: "ready" };
        } catch (error) {
          outcome = { status: "error", message: errorToString(error) };
        }
        await request.complete(outcome).catch(this.operations.report);
      }
    });
  }

  private async finishPending(outcome: LaunchOutcome): Promise<void> {
    while (this.pending.length > 0) {
      await this.pending
        .shift()!
        .complete(outcome)
        .catch(this.operations.report);
    }
  }

  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.phase = "stopping";
    this.stopping = this.finishShutdown();
    return this.stopping;
  }

  private async finishShutdown(): Promise<void> {
    await this.booted;
    await this.draining;
    await this.operations.shutdown();
    this.operations.release();
    this.phase = "stopped";
    await this.finishPending({ status: "retry" });
    this.operations.quit();
  }
}
