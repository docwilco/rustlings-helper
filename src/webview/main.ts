import { provideVSCodeDesignSystem, vsCodeButton, vsCodeCheckbox, vsCodeTextField } from "@vscode/webview-ui-toolkit";

provideVSCodeDesignSystem().register(vsCodeButton(), vsCodeCheckbox(), vsCodeTextField());
