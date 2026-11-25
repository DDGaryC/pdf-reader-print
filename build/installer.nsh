; What electron-builder does not do on its own. SHELL_CONTEXT is the current user's registry,
; because this program installs for one user and needs no administrator rights.
;
; electron-builder's fileAssociations is left out of package.json on purpose. It overwrites the
; default value of .pdf, which on this computer belongs to PDFgear, keeps no copy of it, and does
; not put it back on uninstall. Everything here only adds this program as one more choice.

!define PDF_PROGID "PDFReaderPrint.pdf"
!define REGISTERED_NAME "PDFReaderPrint"
!define CAPABILITIES_KEY "Software\${REGISTERED_NAME}\Capabilities"

; Always for this user only, so the "all users" question and its elevation never come up.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro tellExplorerAssociationsChanged
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend

!macro customInstall
  ; How this program opens a PDF.
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDF_PROGID}" "" "PDF 文件"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDF_PROGID}\DefaultIcon" "" "$INSTDIR\resources\pdf.ico"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDF_PROGID}\shell" "" "open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDF_PROGID}\shell\open" "" "用 ${PRODUCT_NAME} 開啟"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDF_PROGID}\shell\open\command" "" '"$appExe" "%1"'

  ; Listed under "Open with", next to what is already there.
  WriteRegStr SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${PDF_PROGID}" ""

  ; Listed in the Windows default apps settings.
  WriteRegStr SHELL_CONTEXT "${CAPABILITIES_KEY}" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${CAPABILITIES_KEY}" "ApplicationDescription" "閱讀與列印 PDF，橫向頁自動轉向"
  WriteRegStr SHELL_CONTEXT "${CAPABILITIES_KEY}" "ApplicationIcon" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "${CAPABILITIES_KEY}\FileAssociations" ".pdf" "${PDF_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${REGISTERED_NAME}" "${CAPABILITIES_KEY}"

  !insertmacro tellExplorerAssociationsChanged
!macroend

!macro customUnInstall
  ; An update runs this too, and puts everything back straight after.
  ${ifNot} ${isUpdated}
    DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${REGISTERED_NAME}"
    DeleteRegKey SHELL_CONTEXT "Software\${REGISTERED_NAME}"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${PDF_PROGID}"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\${PDF_PROGID}"

    ; This program never sets this value. If something else pointed it here, it must not
    ; stay pointing at a program that is gone. Any other value is not ours to touch.
    Push $0
    ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.pdf" ""
    ${if} $0 == "${PDF_PROGID}"
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf" ""
    ${endIf}
    Pop $0

    !insertmacro tellExplorerAssociationsChanged
  ${endIf}
!macroend
