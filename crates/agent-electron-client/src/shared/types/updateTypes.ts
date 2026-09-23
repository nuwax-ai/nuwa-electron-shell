export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface UpdateInfo {
  hasUpdate: boolean;
  version?: string;
  releaseDate?: string;
  releaseNotes?: string;
  error?: string;
  /** 上一次检查仍在进行中，本次调用被跳过 */
  alreadyChecking?: boolean;
}

export interface UpdateCheckOptions {
  /** 后台检查不进入可见的 checking/error 状态，只在完成后同步结果。 */
  background?: boolean;
}

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  /** 更新元数据中的发布日期（ISO 字符串，缺失时不展示）。 */
  releaseDate?: string;
  /** 更新元数据中的纯文本发布说明。 */
  releaseNotes?: string;
  progress?: UpdateProgress;
  error?: string;
  /** false 表示当前安装方式不支持自动更新（如 Windows MSI），需要手动下载 */
  canAutoUpdate?: boolean;
  /** true 表示因应用在只读卷运行（如从「下载」直接打开）导致无法就地更新，应引导用户前往下载页 */
  isReadOnlyVolumeError?: boolean;
}

/** webview（nuwax 前端）消费的宿主更新状态：UpdateState + 宿主客户端版本号。 */
export interface ClientUpdateState extends UpdateState {
  /** 宿主客户端版本（app.getVersion()），logo 旁版本徽标展示用。 */
  hostVersion: string;
}
