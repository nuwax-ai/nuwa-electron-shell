import { AsyncLocalStorage } from "node:async_hooks";
import * as net from "node:net";

export type LocalServiceId = "agent" | "fileServer" | "ttyd" | "ttydInternal" | "gateway";
export type LocalEndpoint = {
  service: LocalServiceId;
  host: string;
  port: number;
  status: "reserved" | "starting" | "ready" | "stopped" | "failed";
  generation: number;
};
export type LocalStartResult = { success: boolean; error?: string; errorCode?: string; errorStage?: "spawn" };
type Reservation = { close(): Promise<void> };
export type LocalPortPolicy = {
  ranges: ReadonlyArray<readonly [number, number]>;
  saved?: Partial<Record<LocalServiceId, number>>;
  persist?(ports: Partial<Record<LocalServiceId, number>>): void;
  log?(message: string): void;
  /** Injectable real-bind primitive for platform and exhausted-pool tests. */
  bind?(port: number, host: string): Promise<Reservation>;
};

function portError(error: unknown): boolean {
  const value = error as { code?: string; errorCode?: string; error?: string; message?: string };
  return /EADDRINUSE|EACCES|address already in use|Port \d+ already in use/i.test(
    [value?.code, value?.errorCode, value?.error, value?.message].join(" "),
  );
}

async function bindPort(port: number, host: string): Promise<Reservation> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen({ port, host, exclusive: true }, () => {
      server.removeListener("error", reject);
      server.unref();
      resolve({ close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

/** Product-neutral allocator. A consumer opts in with its own ranges and storage. */
export class LocalPortManager {
  readonly host = "127.0.0.1";
  private endpoints = new Map<LocalServiceId, LocalEndpoint>();
  private reservations = new Map<LocalServiceId, Reservation>();
  private saved: Partial<Record<LocalServiceId, number>>;
  private queue: Promise<unknown> = Promise.resolve();
  private starts = new Map<LocalServiceId, Promise<LocalStartResult>>();
  private controller = new AbortController();
  private gatewayController = new AbortController();
  private revision = 0;
  private publish?: (signal?: AbortSignal) => Promise<void>;
  private operationScope = new AsyncLocalStorage<AbortSignal>();
  private operationSignalProvider?: () => AbortSignal;
  setOperationSignalProvider(provider: () => AbortSignal): void { this.operationSignalProvider = provider; }
  get operationSignal(): AbortSignal | undefined { return this.operationScope.getStore(); }
  runScoped<T>(work: () => Promise<T>): Promise<T> {
    const signal = this.operationSignalProvider?.();
    return signal ? this.operationScope.run(signal, work) : work();
  }

  constructor(private policy: LocalPortPolicy) {
    if (!policy.ranges.length || policy.ranges.some(([min, max]) =>
      !Number.isInteger(min) || !Number.isInteger(max) || min < 1024 || max > 65535 || min > max))
      throw new Error("Invalid automatic port ranges");
    this.saved = {};
    for (const [service, port] of Object.entries(policy.saved ?? {})) {
      if (["agent", "fileServer", "ttyd", "ttydInternal", "gateway"].includes(service) &&
          typeof port === "number" && Number.isInteger(port) && policy.ranges.some(([min, max]) => port >= min && port <= max))
        this.saved[service as LocalServiceId] = port;
    }
  }

  get generation(): number { return this.revision; }
  get(service: LocalServiceId): LocalEndpoint | undefined {
    const value = this.endpoints.get(service);
    return value ? { ...value } : undefined;
  }
  snapshot(): LocalEndpoint[] { return [...this.endpoints.values()].map((value) => ({ ...value })); }
  setBeforePublish(publish: (signal?: AbortSignal) => Promise<void>): void { this.publish = publish; }
  async beforePublish(signal?: AbortSignal): Promise<void> { await this.publish?.(signal ?? this.operationScope.getStore()); }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private signal(service: LocalServiceId, signal?: AbortSignal): AbortSignal {
    const lifetime = service === "gateway" ? this.gatewayController.signal : this.controller.signal;
    const scoped = this.operationScope.getStore();
    return AbortSignal.any([lifetime, ...(signal ? [signal] : []), ...(scoped ? [scoped] : [])]);
  }
  private *candidates(service: LocalServiceId, excluded: Set<number>): Generator<number> {
    const seen = new Set(excluded);
    const previous = this.endpoints.get(service)?.port ?? this.saved[service];
    const allowed = (port: number) => this.policy.ranges.some(([min, max]) => port >= min && port <= max);
    if (previous && allowed(previous) && !seen.has(previous)) { seen.add(previous); yield previous; }
    for (const [min, max] of this.policy.ranges) {
      for (let port = min; port <= max; port++) {
        if (!seen.has(port)) { seen.add(port); yield port; }
      }
    }
  }

  reserve(service: LocalServiceId, signal?: AbortSignal, excluded = new Set<number>()): Promise<number> {
    const activeSignal = this.signal(service, signal);
    return this.serial(async () => {
      activeSignal.throwIfAborted();
      const existing = this.endpoints.get(service);
      if (!excluded.has(existing?.port ?? 0) &&
          (this.reservations.has(service) || existing?.status === "ready")) return existing!.port;
      await this.closeReservation(service);
      const occupied = new Set([...excluded, ...[...this.endpoints.values()]
        .filter((value) => value.service !== service && value.status !== "stopped" && value.status !== "failed")
        .map((value) => value.port)]);
      let skipped = 0;
      for (const port of this.candidates(service, occupied)) {
        activeSignal.throwIfAborted();
        let reservation: Reservation;
        try { reservation = await (this.policy.bind ?? bindPort)(port, this.host); }
        catch (error) {
          if (!portError(error)) throw error;
          skipped++;
          continue;
        }
        if (activeSignal.aborted) { await reservation.close(); activeSignal.throwIfAborted(); }
        this.reservations.set(service, reservation);
        if (existing?.port !== port || !existing) this.revision++;
        this.endpoints.set(service, { service, host: this.host, port, status: "reserved", generation: this.revision });
        this.policy.log?.(`[LocalPorts] ${service} reserved ${this.host}:${port} generation=${this.revision} skipped=${skipped}`);
        return port;
      }
      throw new Error(`No available local port for ${service} in the configured automatic ranges`);
    });
  }

  async prepare(services: LocalServiceId[], signal?: AbortSignal): Promise<void> {
    for (const service of services) await this.reserve(service, signal);
  }
  private async closeReservation(service: LocalServiceId): Promise<void> {
    const reservation = this.reservations.get(service);
    this.reservations.delete(service);
    await reservation?.close();
  }

  private async stopOwned(stop: () => Promise<unknown>): Promise<void> {
    const result = await stop();
    if (result && typeof result === "object" && "success" in result && result.success === false)
      throw new Error((result as { error?: string; message?: string }).error ??
        (result as { message?: string }).message ?? "Owned service cleanup failed");
  }

  /** The callback must confirm its own listener and health, and clean up a failed start. */
  start<T extends LocalStartResult>(
    service: LocalServiceId,
    start: (port: number, signal: AbortSignal) => Promise<T>,
    stop: () => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<T | LocalStartResult> {
    const pending = this.starts.get(service);
    if (pending) return pending;
    const activeSignal = this.signal(service, signal);
    const operation = (async () => {
      const excluded = new Set<number>();
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          const port = await this.reserve(service, activeSignal, excluded);
          activeSignal.throwIfAborted();
          await this.serial(() => this.closeReservation(service));
          activeSignal.throwIfAborted();
          const endpoint = this.endpoints.get(service)!;
          endpoint.status = "starting";
          let result: T | LocalStartResult;
          try { result = await start(port, activeSignal); }
          catch (error) { result = { success: false, error: String(error), errorCode: (error as NodeJS.ErrnoException).code }; }
          if (activeSignal.aborted) { await this.stopOwned(stop); activeSignal.throwIfAborted(); }
          if (result.success) {
            endpoint.status = "ready";
            this.saved[service] = port;
            this.policy.persist?.({ ...this.saved });
            this.policy.log?.(`[LocalPorts] ${service} ready ${this.host}:${port} generation=${this.revision}`);
            return result;
          }
          endpoint.status = "failed";
          await this.stopOwned(stop);
          // A process creation failure cannot be repaired by changing its listener port.
          if (result.errorStage === "spawn") return result;
          let conflict = portError(result);
          // Native programs do not always preserve the OS error code in stderr.
          // A second real bind distinguishes a raced port from a generic spawn/health failure.
          if (!conflict) {
            try { const probe = await (this.policy.bind ?? bindPort)(port, this.host); await probe.close(); }
            catch (error) { if (!portError(error)) throw error; conflict = true; }
          }
          if (!conflict) return result;
          excluded.add(port);
          this.policy.log?.(`[LocalPorts] ${service} binding failed at ${port}; selecting another port`);
        }
        return { success: false, error: `Local port binding kept changing for ${service}` };
      } catch (error) {
        let cleanupError: unknown;
        try { await this.stopOwned(stop); } catch (failure) { cleanupError = failure; }
        await this.release(service);
        if (cleanupError && this.endpoints.has(service)) this.endpoints.get(service)!.status = "failed";
        return { success: false, error: (activeSignal.aborted ? "Service start cancelled" : String(error)) +
          (cleanupError ? `; service cleanup failed: ${String(cleanupError)}` : "") };
      }
    })();
    this.starts.set(service, operation);
    void operation.finally(() => { if (this.starts.get(service) === operation) this.starts.delete(service); });
    return operation;
  }

  release(service: LocalServiceId): Promise<void> {
    return this.serial(async () => {
      await this.closeReservation(service);
      const endpoint = this.endpoints.get(service);
      if (endpoint) endpoint.status = "stopped";
    });
  }
  /** Revoke in-flight starts immediately; page hosting has an independent lifetime. */
  invalidateBusiness(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.revision++;
    for (const service of this.endpoints.keys()) if (service !== "gateway") void this.release(service);
  }
  async dispose(): Promise<void> {
    this.invalidateBusiness();
    this.gatewayController.abort();
    for (const service of this.endpoints.keys()) await this.release(service);
  }
}

let manager: LocalPortManager | undefined;
export function setLocalPortManager(value: LocalPortManager | undefined): void { manager = value; }
export function getLocalPortManager(): LocalPortManager | undefined { return manager; }
