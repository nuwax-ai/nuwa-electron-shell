/**
 * 工作空间目录动作（修改/打开）：设置页「工作区目录」行与应用菜单
 * 「文件 → 更改/打开工作空间目录」共用的唯一实现。
 * - 修改：系统目录选择器 → 合并写入 step1_config.workspaceDir（toast 反馈）；
 * - 打开：读当前配置后 shell.openPath；未配置时提示。
 */
import { message } from "antd";
import { I18N_KEYS } from "@shared/constants";
import { setupService } from "./setup";
import { t } from "./i18n";

/** 弹系统目录选择器并把选中目录写入 step1_config.workspaceDir；取消返回 false。 */
export async function modifyWorkspaceDir(): Promise<boolean> {
  const result = await window.electronAPI?.dialog.openDirectory(
    t("Claw.Settings.dialog.selectWorkspace"),
  );
  if (!result?.success || !result.path) return false;
  try {
    const latest = await setupService.getStep1Config();
    await setupService.saveStep1Config({
      ...latest,
      workspaceDir: result.path,
    });
    message.success(t(I18N_KEYS.Toast.SUCCESS.CONFIG_SAVED));
    message.info(t("Claw.Settings.saveConfig.restartHint"));
    return true;
  } catch (error) {
    console.error("Failed to save workspace dir:", error);
    message.error(t(I18N_KEYS.Toast.ERROR.CONFIG_SAVE_FAILED));
    return false;
  }
}

/** 在系统文件管理器中打开当前工作空间目录；未配置时提示。 */
export async function openWorkspaceDir(): Promise<void> {
  const config = await setupService.getStep1Config();
  const dir = config?.workspaceDir ?? "";
  // 没有有效目录时直接提示，避免触发无意义 IPC 调用。
  if (!dir) {
    message.warning(t("Claw.Settings.messages.workspaceNotConfigured"));
    return;
  }
  try {
    const result = await window.electronAPI?.shell?.openPath(dir);
    if (!result?.success) {
      message.error(
        result?.error || t("Claw.Settings.messages.openWorkspaceFailed"),
      );
    }
  } catch {
    message.error(t("Claw.Settings.messages.openWorkspaceFailed"));
  }
}
