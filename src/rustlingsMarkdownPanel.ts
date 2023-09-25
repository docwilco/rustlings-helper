import * as vscode from "vscode";
import { Uri } from 'vscode';
import { RustlingsExercisesProvider } from "./rustlingsExercisesProvider";

function getUri(
    webview: vscode.Webview,
    extensionUri: Uri,
    pathList: string[]
) {
    return webview.asWebviewUri(Uri.joinPath(extensionUri, ...pathList));
}

function generateNonce() {
    let text = '';
    const possible =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export class RustlingsMarkdownPanel {
    public static currentPanel: RustlingsMarkdownPanel | undefined;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        private readonly _panel: vscode.WebviewPanel,
        private readonly _exercisesProvider: RustlingsExercisesProvider,
        extensionUri: Uri
    ) {
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent(
            this._panel.webview,
            extensionUri
        );
        this._setWebviewMessageListener(this._panel.webview);
    }

    public static render(
        extensionUri: Uri,
        exercisesProvider: RustlingsExercisesProvider,
        show?: 'hint' | 'readme',
    ) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const column = editor.viewColumn
            ? editor.viewColumn + 1
            : vscode.ViewColumn.Active;
        if (RustlingsMarkdownPanel.currentPanel) {
            RustlingsMarkdownPanel.currentPanel._panel.reveal(
                column,
                true
            );
        } else {
            const panel = vscode.window.createWebviewPanel(
                "rustlingsHelper.infoPanel",
                "Rustlings Info",
                { viewColumn: column, preserveFocus: true },
                {
                    enableScripts: true,
                    localResourceRoots: [
                        Uri.joinPath(extensionUri, "out"),
                        Uri.joinPath(extensionUri, "view"),
                    ],
                }
            );
            RustlingsMarkdownPanel.currentPanel = new RustlingsMarkdownPanel(
                panel,
                exercisesProvider,
                extensionUri
            );
        }
        if (editor) {
            RustlingsMarkdownPanel.activeEditorChanged(editor, show);
        }
    }

    public static activeEditorChanged(
        editor: vscode.TextEditor | undefined,
        show?: 'hint' | 'readme',
    ) {
        if (!editor) {
            return;
        }
        const panel = RustlingsMarkdownPanel.currentPanel;
        if (!panel) {
            return;
        }
        const exercise = panel._exercisesProvider.exerciseByUri(
            editor.document.uri
        );
        if (!exercise) {
            return;
        }
        panel._panel.webview.postMessage({
            command: "setExerciseInfo",
            hintHtml: exercise.hintHtml,
            readmeHtml: exercise.readmeHtml,
            showHint: show === 'hint',
            showReadme: show === 'readme',
        });
    }

    public dispose() {
        RustlingsMarkdownPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private _getWebviewContent(webview: vscode.Webview, extensionUri: Uri) {
        const webviewUri = getUri(webview, extensionUri, ["out", "webview.js"]);

        const nonce = generateNonce();

        return /*html*/ `
            <!DOCTYPE html>
            <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta 
                        name="viewport" 
                        content="width=device-width,initial-scale=1.0"
                    >
                    <meta
                        http-equiv="Content-Security-Policy"
                        content="default-src 'none';
                            style-src ${webview.cspSource};
                            font-src ${webview.cspSource};
                            img-src ${webview.cspSource} https:;
                            script-src 'nonce-${nonce}';"
                    >
                    <title>Hello World!</title>
                </head>
                <body>
                    <vscode-panels>
                        <vscode-panel-tab id="hint-tab">
                            HINT
                        </vscode-panel-tab>
                        <vscode-panel-tab id="readme-tab">
                            README
                        </vscode-panel-tab>
                        <vscode-panel-view id="hint-view">
                            <div id="hint-visible" hidden>
                                <vscode-button id="hide-hint-button">
                                    Hide Hint
                                </vscode-button>
                                <div id="hint"></div>
                            </div>
                            <div id="hint-hidden">
                                <vscode-button id="show-hint-button">
                                    Show Hint
                                </vscode-button>
                            </div>
                        </vscode-panel-view>
                        <vscode-panel-view id="readme-view">
                            <div id="readme-visible" hidden>
                                <vscode-button id="hide-readme-button">
                                    Hide README
                                </vscode-button>
                                <div id="readme"></div>
                            </div>
                            <div id="readme-hidden">
                                <vscode-button id="show-readme-button">
                                    Show README
                                </vscode-button>
                            </div>
                        </vscode-panel-view>
                    </vscode-panels>
                    <script type="module" nonce="${nonce}" src="${webviewUri}">
                    </script>
                </body>
            </html>
        `;
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(
            (message: any) => {
                const command = message.command;
                const text = message.text;

                switch (command) {
                    case "hello":
                        vscode.window.showInformationMessage(text);
                        return;
                }
            },
            undefined,
            this._disposables
        );
    }
}
