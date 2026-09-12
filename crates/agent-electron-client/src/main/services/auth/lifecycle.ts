/** 串行化注册/服务操作；失效立即撤销代次，异步结果必须在提交前再次校验。 */
export type ServiceResult = {
  success: boolean;
  error?: string;
  results?: Record<string, { success: boolean; error?: string }>;
};
export interface LifecycleAdapter<T> {
  authenticated(): boolean;
  register(signal: AbortSignal): Promise<T>;
  commit(value: T): void;
  start(signal: AbortSignal): Promise<ServiceResult>;
  stop(): Promise<ServiceResult>;
  changed?(phase: string, error?: string): void;
}
export class AuthLifecycle<T> {
  private controller = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private starting?: Promise<ServiceResult>;
  private registered?: T;
  private ready = false;
  constructor(private adapter: LifecycleAdapter<T>) {}
  private enqueue<R>(work: () => Promise<R>): Promise<R> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private check(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!this.adapter.authenticated()) throw new Error("Login required");
  }
  invalidate(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.registered = undefined;
    this.ready = false;
    this.starting = undefined;
  }
  sync(): Promise<T> {
    const signal = this.controller.signal;
    return this.enqueue(async () => {
      this.check(signal);
      this.adapter.changed?.("registering");
      const value = await this.adapter.register(signal);
      this.check(signal);
      this.adapter.commit(value); // 同步提交，期间不允许登出穿插写回
      this.registered = value;
      return value;
    });
  }
  start(force = false): Promise<ServiceResult> {
    if (this.starting) return this.starting;
    if (!force && this.ready && this.adapter.authenticated())
      return Promise.resolve({ success: true });
    const signal = this.controller.signal;
    const operation = this.enqueue(async () => {
      try {
        this.check(signal);
        if (!this.registered || force) {
          this.adapter.changed?.("registering");
          const value = await this.adapter.register(signal);
          this.check(signal);
          this.adapter.commit(value);
          this.registered = value;
        }
        this.check(signal);
        this.adapter.changed?.("starting");
        const result = await this.adapter.start(signal);
        this.check(signal);
        this.ready = result.success;
        this.adapter.changed?.(
          result.success ? "ready" : "service-failed",
          result.error,
        );
        return result;
      } catch (error) {
        if (!signal.aborted)
          this.adapter.changed?.(
            this.registered ? "service-failed" : "registration-failed",
            String(error),
          );
        return {
          success: false,
          error: signal.aborted ? "Session changed" : String(error),
        };
      }
    });
    this.starting = operation;
    void operation.finally(() => {
      if (this.starting === operation) this.starting = undefined;
    });
    return operation;
  }
  stop(): Promise<ServiceResult> {
    this.invalidate();
    this.adapter.changed?.("stopping");
    return this.enqueue(async () => {
      const result = await this.adapter.stop();
      this.adapter.changed?.(
        result.success ? "stopped" : "stop-failed",
        result.error,
      );
      return result;
    });
  }
  run<R>(work: () => Promise<R>): Promise<R> {
    const signal = this.controller.signal;
    return this.enqueue(async () => {
      this.check(signal);
      if (!this.registered) throw new Error("Registration required");
      const result = await work();
      this.check(signal);
      return result;
    });
  }
}
// 社区版不配置，商业 overlay 在 IPC 注册阶段注入唯一实例。
export let commercialLifecycle: AuthLifecycle<any> | undefined;
export function setCommercialLifecycle(value: AuthLifecycle<any>): void {
  commercialLifecycle = value;
}
