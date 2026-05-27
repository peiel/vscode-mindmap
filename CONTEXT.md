# Project Context

## 2026-05-27: macOS Cmd+H hide regression

User environment:
- Editor in use: Visual Studio Code.
- Cursor had been uninstalled. A leftover Cursor data directory existed at `/Users/peiel/.cursor` and was removed during the investigation.
- Installed VS Code extension path checked: `/Users/peiel/.vscode/extensions/oorzcc.mind-map-1.0.6`.

Relevant history:
- `7e348e8 Preserve macOS hide shortcut` added a frontend guard for macOS `Cmd+H`.
- `fa69bf9 fix: improve macOS Cmd+H hide application handling` added the `hideApplication` webview message and backend AppleScript bridge.
- Later note-panel changes did not remove the frontend `Cmd+H` handling.

Findings:
- The final `mind-map-1.0.6.vsix` package from 2026-05-27 still contained the frontend `Cmd+H` capture and backend `hideApplication` handler.
- The installed VS Code extension also contained that code, so the regression was not caused by Cursor leftovers or by the frontend handler being deleted.
- VS Code logs showed the backend bridge reached the extension host but failed while running:
  `/usr/bin/osascript -e 'tell application "System Events" to set visible of first application process whose frontmost is true to false'`.
- Root cause: the original backend hide path depended only on `System Events`, which is brittle on macOS because it can fail due to automation/accessibility/TCC behavior.

Fix:
- `src/mindEditor.ts` now tries multiple AppleScript hide strategies:
  1. `tell application id "com.microsoft.VSCode" to hide`
  2. `tell application "<vscode.env.appName>" to hide`
  3. Original `System Events` frontmost-process fallback
- This avoids making the fragile `System Events` path the only way to hide VS Code.

Verification:
- `npm run package` succeeded with Node from `/Users/peiel/.nvm/versions/node/v22.22.2/bin`.
- A repaired VSIX was generated at `mind-map-1.0.6-cmdh-direct-hide.vsix`.
- The repaired VSIX was installed into VS Code with `code --install-extension ... --force`.
- Installed extension file `/Users/peiel/.vscode/extensions/oorzcc.mind-map-1.0.6/dist/extension.js` was verified to include `com.microsoft.VSCode`.
- User confirmed `Cmd+H` works after the fix.

Current related commit:
- `6ccc8e5 Fix macOS Cmd+H hide fallback`
