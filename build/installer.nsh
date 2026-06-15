; 和ターミナル (WaTerm) — NSIS カスタムインストーラ拡張
; 起動時のウェルカムページを「新規 / 更新 / アンインストール」の3択ページに差し替える。
; electron-builder の customWelcomePage マクロを定義すると、既定の MUI ウェルカムページの代わりに挿入される。
; （/S サイレント時＝electron-updater の自動更新では、このカスタムページは表示されず通常の更新フローになる）

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  Var WaPrevUninst   ; 既存インストールの UninstallString（無ければ空）
  Var WaPrevLoc      ; 既存インストールの InstallLocation
  Var WaMode         ; 選択結果: new / update / uninstall
  Var WaRbNew
  Var WaRbUpd
  Var WaRbUnin
  Var WaInfoLabel

  ; 既存インストールを HKCU→HKLM の順に探して $WaPrevUninst / $WaPrevLoc を埋める
  !macro WaDetectPrev
    ClearErrors
    ReadRegStr $WaPrevUninst HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    StrCpy $WaPrevLoc ""
    ReadRegStr $WaPrevLoc HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $WaPrevUninst == ""
      ReadRegStr $WaPrevUninst HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
      ReadRegStr $WaPrevLoc HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${EndIf}
  !macroend

  Function WaModeShow
    !insertmacro WaDetectPrev

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 12u "インストール方法の選択 — 和ターミナル (WaTerm)"
    Pop $0

    ${If} $WaPrevUninst == ""
      ${NSD_CreateLabel} 0 16u 100% 16u "このコンピューターには 和ターミナル がまだインストールされていません。新規インストールを行います。"
    ${Else}
      ${NSD_CreateLabel} 0 16u 100% 16u "既存の 和ターミナル が見つかりました。操作を選択してください。"
    ${EndIf}
    Pop $WaInfoLabel

    ${NSD_CreateRadioButton} 8u 38u 95% 12u "新規インストール（クリーン）：以前の版を削除してから入れ直します"
    Pop $WaRbNew
    ${NSD_CreateRadioButton} 8u 54u 95% 12u "更新（上書き）：設定を保ったまま新しい版へ更新します"
    Pop $WaRbUpd
    ${NSD_CreateRadioButton} 8u 70u 95% 12u "アンインストール：このコンピューターから削除します"
    Pop $WaRbUnin

    ${NSD_CreateLabel} 8u 90u 95% 28u "※設定・セッション（%APPDATA%\waterm）は「更新」「新規」では保持されます（消えません）。完全に消すにはアンインストール後に手動削除してください。"
    Pop $0

    ${If} $WaPrevUninst == ""
      ; 既存なし：新規のみ有効
      ${NSD_Check} $WaRbNew
      EnableWindow $WaRbUpd 0
      EnableWindow $WaRbUnin 0
    ${Else}
      ; 既存あり：既定は「更新」
      ${NSD_Check} $WaRbUpd
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function WaModeLeave
    ${NSD_GetState} $WaRbUnin $0
    ${If} $0 == 1
      StrCpy $WaMode "uninstall"
    ${Else}
      ${NSD_GetState} $WaRbNew $1
      ${If} $1 == 1
        StrCpy $WaMode "new"
      ${Else}
        StrCpy $WaMode "update"
      ${EndIf}
    ${EndIf}

    ; アンインストール：既存のアンインストーラを起動して、このインストーラは終了
    ${If} $WaMode == "uninstall"
      ${If} $WaPrevUninst != ""
        Exec '$WaPrevUninst'
      ${EndIf}
      Quit
    ${EndIf}

    ; 新規（クリーン）：既存があれば先にサイレントで在席アンインストールしてから続行
    ${If} $WaMode == "new"
    ${AndIf} $WaPrevUninst != ""
    ${AndIf} $WaPrevLoc != ""
      ClearErrors
      ExecWait '$WaPrevUninst /S _?=$WaPrevLoc' $0
    ${EndIf}
  FunctionEnd

  ; electron-builder のページ並びに割り込む（既定ウェルカムページの代替）
  !macro customWelcomePage
    Page custom WaModeShow WaModeLeave
  !macroend
!endif
