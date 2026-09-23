; ---------------------------------------------------------------------------
; Nuwax 商业版 NSIS 定制：安装向导显示中文营销名「女娲Nuwax」
;
; 背景：productName 一个值同时决定「显示名」与「产物文件名」，而商业身份要求
; 文件名/包名一律 ASCII（Nuwax-Setup-*.exe / Nuwax.app / deb 包名 nuwax），
; 故 productName 必须保持 ASCII "Nuwax"，中文名只能在向导 UI 层单独覆盖。
;
; 机制：electron-builder 的 common.nsh 先执行
;     BrandingText "${PRODUCT_NAME} ${VERSION}"   ← 底部版本行
;     Name "${PRODUCT_NAME}"                      ← 向导标题与正文
; 而本文件的 customHeader 宏由 installer.nsi 在其**之后**插入；NSIS 中后写的
; 同名指令覆盖先写的 → 只重写 Name 即可让标题/正文变中文。
;
; ⚠️ 刻意不重写 BrandingText：底部「Nuwax 1.0.4」保持 ASCII（产品要求）。
; 卸载程序文件名走 PRODUCT_FILENAME（同为 ASCII），与 autoUpdater 的
; app.getName() → "Nuwax" 对齐，改动不影响自动更新查找卸载程序。
; NSIS Unicode 默认开启（nsis.unicode !== false），中文字面量安全。
; ---------------------------------------------------------------------------

!macro customHeader
  Name "女娲Nuwax"
!macroend

; electron-builder 25's default CHECK_APP_RUNNING only stops matching Nuwax.exe
; processes. The Electron main process owns several helper trees, so a surviving
; child can keep the install directory locked and make the stock retry loop fail.
; First request a graceful shutdown of the app tree, then force-stop that tree if
; it does not exit within the app's 10-second shutdown-cleanup window.
!macro customCheckAppRunning
  ${if} $EXEFILE != "${APP_EXECUTABLE_FILENAME}"
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      ${ifNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK customDoStopApp
        Quit
        customDoStopApp:
      ${endIf}

      DetailPrint `Closing running "${PRODUCT_NAME}" and its child processes...`

      ; Give app-side cleanup (which can take up to 10 seconds) time to finish.
      !ifdef INSTALL_MODE_PER_ALL_USERS
        nsExec::Exec `taskkill /t /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $EXEPID"`
      !else
        nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /t /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $EXEPID" /fi "USERNAME eq %USERNAME%"`
      !endif
      Pop $R0

      StrCpy $R1 0
      customWaitForAppExit:
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 != 0
          Goto customAppClosed
        ${endIf}
        ${if} $R1 >= 10
          Goto customForceAppTree
        ${endIf}
        Sleep 1000
        IntOp $R1 $R1 + 1
        Goto customWaitForAppExit

      ; The app did not exit cleanly. Force-stop the process tree so helper
      ; processes do not keep files in the installation directory open.
      customForceAppTree:
      StrCpy $R1 0
      customForceAppTreeLoop:
        !ifdef INSTALL_MODE_PER_ALL_USERS
          nsExec::Exec `taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $EXEPID"`
        !else
          nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $EXEPID" /fi "USERNAME eq %USERNAME%"`
        !endif
        Pop $R0
        Sleep 1000
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 != 0
          Goto customAppClosed
        ${endIf}
        IntOp $R1 $R1 + 1
        ${if} $R1 < 3
          Goto customForceAppTreeLoop
        ${endIf}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY customForceAppTreeLoop
        Quit

      customAppClosed:
    ${endIf}
  ${endIf}
!macroend
