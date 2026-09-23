/**
 * 关于页面 (Electron 版)
 *
 * - 版本号运行时从 Electron 主进程获取
 * - 检查更新 + 下载 + 重启安装 完整流程
 * - 下载完成后弹窗确认是否立即重启安装
 * - Windows MSI 安装用户引导到官网下载安装页
 * - macOS/Linux 上 Squirrel 不发送 download-progress，用本地模拟进度保证进度条有变化
 *
 * 2026-09 行式重排：对齐设置弹窗参考样式——全宽卡片行列表（左标签/右动作），
 * 替代原居中窄卡片；更新状态机、桥调用与旧版逐字一致，仅容器换皮。
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Button, Progress, message, Modal, Switch } from "antd";
import {
  SyncOutlined,
  DownloadOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import { APP_DISPLAY_NAME } from "@shared/constants";
import { t } from "../../services/core/i18n";
import type { UpdateState } from "@shared/types/updateTypes";
import styles from "../../styles/components/AboutPage.module.css";

/** 官网地址，用于关于页「官网」链接 */
const OFFICIAL_WEBSITE_URL = "https://nuwax.com";

/** macOS/Linux 无 download-progress 时，模拟进度从 0 增长到该值（%） */
const SIMULATED_PROGRESS_CAP = 90;
/** 模拟进度更新间隔（ms） */
const SIMULATED_PROGRESS_INTERVAL_MS = 500;
/** 预计下载时长（ms），用于计算每 tick 的增量，约 45s 内从 0 到 SIMULATED_PROGRESS_CAP */
const SIMULATED_DURATION_MS = 45_000;
type UpdateChannel = "stable" | "beta";
const UPDATE_CHANNEL_SETTING_KEY = "update_channel";

export interface AboutPageProps {
  /** webview 前端启动时上报的构建信息（界面版本行展示；未上报时显示未知）。 */
  webMeta?: { appVersion?: string; gitHash?: string };
}

/** 系统信息卡片的只读行：左标签、右值 */
function InfoRow(props: { label: React.ReactNode; value: React.ReactNode }) {
  const { label, value } = props;
  return (
    <div className={styles.row}>
      <div className={styles.rowLabel}>{label}</div>
      <div className={styles.rowValue}>{value}</div>
    </div>
  );
}

export default function AboutPage({ webMeta }: AboutPageProps = {}) {
  const [updateState, setUpdateState] = useState<UpdateState>({
    status: "idle",
  });
  const [appVersion, setAppVersion] = useState<string>("");
  /** 系统信息（app:getSystemInfo：OS/架构/内置 dist 版本） */
  const [systemInfo, setSystemInfo] = useState<{
    platformName?: string;
    osVersion?: string;
    arch?: string;
    bundledDist?: { version: string; gitHash?: string } | null;
  }>({});
  const hasShownInstallModal = useRef(false);
  const [installing, setInstalling] = useState(false);
  /** macOS/Linux 无真实进度时的模拟进度（0..SIMULATED_PROGRESS_CAP），有 progress 时不用 */
  const [simulatedPercent, setSimulatedPercent] = useState(0);
  const simulatedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  /** 调试模式：显示升级检测详细信息 */
  const [showDebugInfo, setShowDebugInfo] = useState(false);
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>("stable");
  const [channelLoading, setChannelLoading] = useState(false);

  // 监听主进程推送的更新状态
  // 注意：preload 的 on() 已剥离 IPC event，callback 直接收到 (...args)
  useEffect(() => {
    let active = true;
    let statusEventRevision = 0;
    const handler = (state: UpdateState) => {
      if (state) {
        statusEventRevision += 1;
        setUpdateState(state);
      }
    };
    window.electronAPI?.on("update:status", handler as any);
    // 获取运行时版本号
    window.electronAPI?.app?.getVersion().then((v) => {
      if (v) setAppVersion(v);
    });
    // 系统信息（旧宿主无此 IPC 时保持空，展示占位）
    window.electronAPI?.app?.getSystemInfo?.()?.then((info) => {
      if (info) setSystemInfo(info);
    });
    // 先读取主进程当前状态，再静默检查一次，避免进入关于页时展示过期版本信息。
    const syncUpdateState = async () => {
      const eventRevisionAtRequest = statusEventRevision;
      const state = await window.electronAPI?.app?.getUpdateState?.();
      if (active && state && eventRevisionAtRequest === statusEventRevision) {
        setUpdateState(state);
      }
    };
    void (async () => {
      try {
        await syncUpdateState();
        if (!active) return;
        await window.electronAPI?.app?.checkUpdate({ background: true });
        if (active) await syncUpdateState();
      } catch {
        // 进入关于页触发的是静默刷新，失败时保留当前显示状态。
      }
    })();
    // 读取更新通道；旧版本默认按 stable 处理，避免影响已安装用户行为
    window.electronAPI?.settings
      .get(UPDATE_CHANNEL_SETTING_KEY)
      .then((saved) => {
        setUpdateChannel(saved === "beta" ? "beta" : "stable");
      })
      .catch(() => {
        setUpdateChannel("stable");
      });
    return () => {
      active = false;
      window.electronAPI?.off("update:status", handler as any);
    };
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    setUpdateState((prev) => ({ ...prev, status: "checking" }));
    try {
      const result = await window.electronAPI?.app?.checkUpdate();

      // IPC 不可用（API 层返回空），直接恢复 idle
      if (!result) {
        setUpdateState({ status: "idle" });
        return;
      }

      // 上一次检查仍在进行中，本次被跳过；不显示 toast，等待 update:status 事件。
      // 但启动检查可能在 IPC 往返途中恰好已完成且不再发事件，
      // 调一次 getUpdateState() 防止 'checking' 状态永久卡住。
      if (result.alreadyChecking) {
        const s = await window.electronAPI?.app?.getUpdateState?.();
        if (s) setUpdateState(s);
        return;
      }

      // 根据检查结果显示 toast（仅负责消息提示，不在这里推算状态）
      if (result.error) {
        message.error(
          t("Claw.About.checkFailedWithDetail", { error: result.error }),
        );
      } else if (!result.hasUpdate) {
        message.info(t("Claw.About.alreadyLatest"));
      }

      // 从主进程获取权威状态（含 canAutoUpdate），避免 IPC 事件与 invoke 响应
      // 竞争条件导致 Windows MSI 用户看到错误按钮或状态卡住
      const authoritative = await window.electronAPI?.app?.getUpdateState?.();
      if (authoritative) {
        setUpdateState(authoritative);
      } else if (result.error || !result.hasUpdate) {
        // getUpdateState 不可用时的兜底
        setUpdateState({ status: "idle" });
      }
    } catch {
      message.error(t("Claw.About.checkFailed"));
      setUpdateState({ status: "idle" });
    }
  }, []);

  const handleChangeUpdateChannel = useCallback(
    async (checked: boolean) => {
      const nextChannel: UpdateChannel = checked ? "beta" : "stable";
      if (nextChannel === updateChannel) return;

      // 切换到 beta 时：弹出二次确认
      if (nextChannel === "beta") {
        Modal.confirm({
          title: t("Claw.About.channelSwitching"),
          content: (
            <div>
              <p>{t("Claw.About.betaWarning")}</p>
              <p>{t("Claw.About.confirmSwitch")}</p>
            </div>
          ),
          okText: t("Claw.About.confirmSwitchBtn"),
          cancelText: t("Claw.Common.cancel"),
          onOk: async () => {
            setChannelLoading(true);
            try {
              await window.electronAPI?.settings.set(
                UPDATE_CHANNEL_SETTING_KEY,
                "beta",
              );
              setUpdateChannel("beta");
              message.success(t("Claw.About.switchedToBeta"));
              // 确认后自动触发一次 beta 通道的升级检查
              await handleCheckUpdate();
            } catch {
              message.error(t("Claw.About.channelSwitchFailed"));
            } finally {
              setChannelLoading(false);
            }
          },
        });
        return;
      }

      // 切换回 stable：直接切换，无确认弹框，重新检查 stable 通道
      setChannelLoading(true);
      try {
        await window.electronAPI?.settings.set(
          UPDATE_CHANNEL_SETTING_KEY,
          "stable",
        );
        setUpdateChannel("stable");
        message.success(t("Claw.About.switchedToStable"));
        await handleCheckUpdate();
      } catch {
        message.error(t("Claw.About.channelSwitchFailed"));
      } finally {
        setChannelLoading(false);
      }
    },
    [updateChannel, handleCheckUpdate],
  );

  // macOS/Linux：Squirrel 不发送 download-progress，用定时器模拟进度使进度条有变化
  useEffect(() => {
    const isDownloading = updateState.status === "downloading";
    const hasRealProgress = updateState.progress != null;

    if (isDownloading && !hasRealProgress) {
      setSimulatedPercent(0);
      const increment =
        (SIMULATED_PROGRESS_CAP / SIMULATED_DURATION_MS) *
        SIMULATED_PROGRESS_INTERVAL_MS;
      const id = setInterval(() => {
        setSimulatedPercent((prev) => {
          const next = prev + increment;
          return next >= SIMULATED_PROGRESS_CAP ? SIMULATED_PROGRESS_CAP : next;
        });
      }, SIMULATED_PROGRESS_INTERVAL_MS);
      simulatedIntervalRef.current = id;
      return () => {
        clearInterval(id);
        simulatedIntervalRef.current = null;
      };
    }

    if (!isDownloading || hasRealProgress) {
      if (simulatedIntervalRef.current) {
        clearInterval(simulatedIntervalRef.current);
        simulatedIntervalRef.current = null;
      }
      setSimulatedPercent(0);
    }
  }, [updateState.status, updateState.progress]);

  // 下载完成后自动弹窗确认安装
  useEffect(() => {
    if (updateState.status === "downloaded" && !hasShownInstallModal.current) {
      hasShownInstallModal.current = true;
      const modal = Modal.confirm({
        title: t("Claw.About.updateDownloaded"),
        content: t("Claw.About.updateDownloadedConfirm", {
          version: updateState.version,
        }),
        okText: t("Claw.About.restartNow"),
        cancelText: t("Claw.About.later"),
        okButtonProps: { loading: false },
        onOk: async () => {
          modal.update({ okButtonProps: { loading: true } });
          try {
            const result = await window.electronAPI?.app?.installUpdate?.();
            if (!result || !result.success) {
              const errorMessage =
                result?.error || t("Claw.About.installFailed");
              message.error(errorMessage);
              modal.update({ okButtonProps: { loading: false } });
              return Promise.reject(new Error(errorMessage));
            }
          } catch {
            message.error(t("Claw.About.installFailed"));
            modal.update({ okButtonProps: { loading: false } });
            return Promise.reject(new Error(t("Claw.About.installFailed")));
          }
        },
      });
    }
    // 状态回到非 downloaded 时重置标记
    if (updateState.status !== "downloaded") {
      hasShownInstallModal.current = false;
    }
  }, [updateState.status, updateState.version]);

  const handleDownload = useCallback(async () => {
    // 立即切换到 downloading 状态，避免点击后无反馈
    setUpdateState((prev) => ({
      ...prev,
      status: "downloading",
      progress: undefined,
    }));
    try {
      const result = await window.electronAPI?.app?.downloadUpdate?.();
      if (!result || !result.success) {
        message.error(result?.error || t("Claw.About.downloadFailed"));
        setUpdateState((prev) => ({ ...prev, status: "available" }));
      }
    } catch {
      message.error(t("Claw.About.downloadFailed"));
      setUpdateState((prev) => ({ ...prev, status: "available" }));
    }
  }, []);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    try {
      const result = await window.electronAPI?.app?.installUpdate?.();
      if (!result || !result.success) {
        message.error(result?.error || t("Claw.About.installFailed"));
        setInstalling(false);
      }
    } catch {
      message.error(t("Claw.About.installFailed"));
      setInstalling(false);
    }
  }, []);

  const handleOpenReleases = useCallback(() => {
    window.electronAPI?.app?.openReleasesPage?.();
  }, []);

  /** 在系统默认浏览器中打开官网 */
  const handleOpenOfficialWebsite = useCallback(async () => {
    try {
      await window.electronAPI?.shell?.openExternal(OFFICIAL_WEBSITE_URL);
    } catch (e) {
      console.error("[AboutPage] openExternal failed:", e);
    }
  }, []);

  /** 获取调试信息 */
  const handleGetDebugInfo = useCallback(async () => {
    try {
      const info = await window.electronAPI?.app?.getUpdateDebugInfo?.();
      if (info && info.success) {
        setDebugInfo(info);
        setShowDebugInfo(true);
      } else {
        message.error(t("Claw.About.getDebugInfoFailed"));
      }
    } catch (e) {
      console.error("[AboutPage] getUpdateDebugInfo failed:", e);
      message.error(t("Claw.About.getDebugInfoFailed"));
    }
  }, []);

  const {
    status: updateStatus,
    version: updateVersion,
    progress: updateProgress,
    error: updateError,
    canAutoUpdate: autoUpdate,
    isReadOnlyVolumeError: readOnlyVolume,
  } = updateState ?? { status: "idle" as const };
  const isDownloading = updateStatus === "downloading";
  // 有真实进度（如 Windows）用主进程推送的 progress；无则用本地模拟进度（macOS/Linux）
  const displayPercent =
    updateProgress != null
      ? Math.round(updateProgress.percent)
      : Math.round(simulatedPercent);

  /**
   * 版本行的状态说明（行左 desc）与动作按钮（行右 control）。
   * 6 态状态机与旧版 renderUpdateSection 一致，只把「按钮右置 + 说明做行内描述」。
   */
  const renderUpdateStatus = (): {
    desc?: React.ReactNode;
    control?: React.ReactNode;
  } => {
    switch (updateStatus) {
      case "checking":
        return {
          control: (
            <Button icon={<SyncOutlined spin />} disabled>
              {t("Claw.About.checking")}
            </Button>
          ),
        };

      case "available":
        return {
          desc: (
            <div className={styles.rowDesc}>
              {t("Claw.About.versionFound", { version: updateVersion })}
            </div>
          ),
          control:
            autoUpdate === false ? (
              <Button
                type="primary"
                icon={<LinkOutlined />}
                onClick={handleOpenReleases}
              >
                {t("Claw.About.goToDownloadPage")}
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={handleDownload}
              >
                {t("Claw.About.downloadUpdate")}
              </Button>
            ),
        };

      case "downloading":
        // 进度条独占行下区块（见渲染处 .updateProgress），行内只放文案
        return {
          desc: (
            <div className={styles.rowDesc}>
              {t("Claw.About.downloading", {
                version: updateVersion,
                percent: displayPercent,
              })}
            </div>
          ),
        };

      case "downloaded":
        return {
          desc: (
            <div
              className={styles.rowDesc}
              style={{ color: "var(--color-success)" }}
            >
              {t("Claw.About.versionDownloaded", { version: updateVersion })}
            </div>
          ),
          control: (
            <Button type="primary" onClick={handleInstall} loading={installing}>
              {t("Claw.About.installUpdate")}
            </Button>
          ),
        };

      case "error":
        // 只读卷错误（如从「下载」直接打开）：无法就地更新，引导用户前往下载页或移动应用后重试
        if (readOnlyVolume) {
          return {
            desc: (
              <div className={styles.rowDesc} style={{ lineHeight: 1.5 }}>
                {t("Claw.About.readOnlyVolumeError")}
              </div>
            ),
            control: (
              <>
                <Button
                  type="primary"
                  icon={<LinkOutlined />}
                  onClick={handleOpenReleases}
                >
                  {t("Claw.About.goToDownloadPage")}
                </Button>
                <Button icon={<SyncOutlined />} onClick={handleCheckUpdate}>
                  {t("Claw.Common.retry")}
                </Button>
              </>
            ),
          };
        }
        return {
          desc: (
            <div
              className={styles.rowDesc}
              style={{ color: "var(--color-error)" }}
            >
              {updateError || t("Claw.About.updateError")}
            </div>
          ),
          control: (
            <Button icon={<SyncOutlined />} onClick={handleCheckUpdate}>
              {t("Claw.Common.retry")}
            </Button>
          ),
        };

      default:
        return {
          control: (
            <Button icon={<SyncOutlined />} onClick={handleCheckUpdate}>
              {t("Claw.About.checkUpdate")}
            </Button>
          ),
        };
    }
  };

  const showReleaseMetadata =
    !!updateState.version &&
    ["available", "downloading", "downloaded", "error"].includes(
      updateStatus,
    ) &&
    (!!updateState.releaseDate || !!updateState.releaseNotes);

  const updateStatusView = renderUpdateStatus();

  return (
    <div className={styles.page}>
      {/* 关于：版本/更新、品牌、Beta 通道 */}
      <div className={styles.group}>
        <div className={styles.groupCard}>
          {/* 版本行：左「客户端版本 vX.Y.Z」+ 状态说明，右检查更新/状态动作 */}
          <div className={styles.row}>
            <div className={styles.rowInfo}>
              <div className={styles.rowLabel}>
                {t("Claw.About.systemInfo.clientVersion")}
                <span className={styles.rowValue}>v{appVersion || "..."}</span>
              </div>
              {updateStatusView.desc}
            </div>
            {updateStatusView.control != null && (
              <div className={styles.rowControl}>
                {updateStatusView.control}
              </div>
            )}
          </div>
          {/* 下载中：进度条独占行下区块 */}
          {isDownloading && (
            <div className={styles.updateProgress}>
              <Progress
                percent={displayPercent}
                size="small"
                status="active"
                showInfo={updateProgress == null}
                strokeColor="var(--color-primary)"
              />
            </div>
          )}
          {/* 品牌行：左「关于 {应用名}」+ 描述，右前往官网 */}
          <div className={styles.row}>
            <div className={styles.rowInfo}>
              <div className={`${styles.rowLabel} ${styles.rowLabelBrand}`}>
                <img
                  src="./icon.png"
                  alt={APP_DISPLAY_NAME}
                  className={styles.brandIcon}
                />
                {t("Claw.About.aboutApp", { appName: APP_DISPLAY_NAME })}
              </div>
              <div className={styles.rowDesc}>
                {t("Claw.About.crossPlatformDescription")}
              </div>
              <div className={`${styles.rowDesc} ${styles.rowDescMono}`}>
                {OFFICIAL_WEBSITE_URL}
              </div>
            </div>
            <div className={styles.rowControl}>
              <Button onClick={handleOpenOfficialWebsite}>
                {t("Claw.About.openOfficialWebsite")}
              </Button>
            </div>
          </div>
          {/* Beta 通道行：左说明，右 Switch */}
          <div className={styles.row}>
            <div className={styles.rowInfo}>
              <div className={styles.rowLabel}>
                {t("Claw.About.betaChannel")}
              </div>
              <div className={styles.rowDesc}>
                {t("Claw.About.betaDisclaimer")}
              </div>
            </div>
            <div className={styles.rowControl}>
              <Switch
                size="small"
                checked={updateChannel === "beta"}
                loading={channelLoading}
                onChange={handleChangeUpdateChannel}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 系统信息：客户端/界面(nuwax pc web)/操作系统/本地化内置 dist 四行 */}
      <div className={styles.group}>
        <div className={styles.groupTitle}>
          {t("Claw.About.systemInfo.title")}
        </div>
        <div className={styles.groupCard}>
          <InfoRow
            label={t("Claw.About.systemInfo.clientVersion")}
            value={`v${appVersion || "..."}`}
          />
          <InfoRow
            label={t("Claw.About.systemInfo.uiVersion")}
            value={
              webMeta?.appVersion
                ? `v${webMeta.appVersion}${
                    webMeta.gitHash ? ` (${webMeta.gitHash})` : ""
                  }`
                : t("Claw.About.systemInfo.unknown")
            }
          />
          <InfoRow
            label={t("Claw.About.systemInfo.os")}
            value={
              systemInfo.osVersion
                ? `${systemInfo.platformName ?? ""} ${systemInfo.osVersion} · ${
                    systemInfo.arch ?? ""
                  }`
                : t("Claw.About.systemInfo.unknown")
            }
          />
          <InfoRow
            label={t("Claw.About.systemInfo.bundledDist")}
            value={
              systemInfo.bundledDist
                ? `v${systemInfo.bundledDist.version}${
                    systemInfo.bundledDist.gitHash
                      ? ` (${systemInfo.bundledDist.gitHash})`
                      : ""
                  }`
                : t("Claw.About.systemInfo.unknown")
            }
          />
        </div>
      </div>

      {/* 发布元数据：发现更新时展示发布日期与版本说明 */}
      {showReleaseMetadata && (
        <div className={styles.group}>
          <div className={styles.groupCard}>
            <div className={styles.metadataBlock}>
              {updateState.releaseDate && (
                <div className={styles.rowDesc}>
                  {t("Claw.About.releaseDate", {
                    date: updateState.releaseDate.slice(0, 10),
                  })}
                </div>
              )}
              {updateState.releaseNotes && (
                <>
                  <div className={styles.metadataTitle}>
                    {t("Claw.About.releaseNotes")}
                  </div>
                  <div className={styles.metadataNotes}>
                    {updateState.releaseNotes}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 调试面板（排障用，默认隐藏） */}
      <div className={styles.debugBar}>
        <Button
          type="link"
          size="small"
          onClick={
            showDebugInfo ? () => setShowDebugInfo(false) : handleGetDebugInfo
          }
          style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}
        >
          {showDebugInfo
            ? t("Claw.About.hideDebugInfo")
            : t("Claw.About.showDebugInfo")}
        </Button>
      </div>

      {showDebugInfo && debugInfo && (
        <div className={styles.debugCard}>
          <div className={styles.debugTitle}>
            {t("Claw.About.debugInfoTitle")}
          </div>
          <div className={styles.debugGrid}>
            <span style={{ color: "var(--color-text-secondary)" }}>
              {t("Claw.About.platform")}:
            </span>
            <span>{debugInfo.platform}</span>

            <span style={{ color: "var(--color-text-secondary)" }}>
              {t("Claw.About.arch")}:
            </span>
            <span>{debugInfo.arch}</span>

            <span style={{ color: "var(--color-text-secondary)" }}>
              {t("Claw.About.packaged")}:
            </span>
            <span>
              {debugInfo.isPackaged
                ? t("Claw.Common.yes")
                : t("Claw.About.devMode")}
            </span>

            <span style={{ color: "var(--color-text-secondary)" }}>
              {t("Claw.About.appVersion")}:
            </span>
            <span>{debugInfo.appVersion}</span>

            <span style={{ color: "var(--color-text-secondary)" }}>
              {t("Claw.About.appName")}:
            </span>
            <span>{debugInfo.appName}</span>

            <span style={{ color: "var(--color-text-secondary)" }}>
              {t("Claw.About.installerType")}:
            </span>
            <span
              style={{
                color:
                  debugInfo.installerType === "nsis"
                    ? "var(--color-success)"
                    : debugInfo.installerType === "msi"
                      ? "var(--color-warning)"
                      : "inherit",
                fontWeight: 500,
              }}
            >
              {debugInfo.installerType?.toUpperCase()}
              {debugInfo.installerType === "nsis" &&
                " " + t("Claw.About.upgradeSupported")}
              {debugInfo.installerType === "msi" &&
                " " + t("Claw.About.manualDownload")}
            </span>

            <span style={{ color: "var(--color-text-secondary)" }}>
              {t("Claw.About.canAutoUpdate")}:
            </span>
            <span
              style={{
                color: debugInfo.canAutoUpdate
                  ? "var(--color-success)"
                  : "var(--color-error)",
                fontWeight: 500,
              }}
            >
              {debugInfo.canAutoUpdate
                ? t("Claw.Common.yes")
                : t("Claw.Common.no")}
            </span>

            {!debugInfo.isPackaged && (
              <>
                <span style={{ color: "var(--color-text-secondary)" }}>
                  {t("Claw.About.appDir")}:
                </span>
                <span style={{ wordBreak: "break-all" }}>
                  {debugInfo.appDir}
                </span>

                <span style={{ color: "var(--color-text-secondary)" }}>
                  {t("Claw.About.exePath")}:
                </span>
                <span style={{ wordBreak: "break-all" }}>
                  {debugInfo.exePath}
                </span>
              </>
            )}

            {debugInfo.uninstallerFiles &&
              debugInfo.uninstallerFiles.length > 0 && (
                <>
                  <span style={{ color: "var(--color-text-secondary)" }}>
                    {t("Claw.About.uninstaller")}:
                  </span>
                  <span>{debugInfo.uninstallerFiles.join(", ")}</span>
                </>
              )}

            <span style={{ color: "var(--color-text-secondary)" }}>
              {t("Claw.About.totalAppFiles")}:
            </span>
            <span>{debugInfo.totalAppFiles}</span>
          </div>
        </div>
      )}
    </div>
  );
}
