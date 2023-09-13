// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as toml from 'toml';
import * as child_process from 'child_process';
import * as child_process_promise from 'child-process-promise';
import * as markdownit from 'markdown-it';

// import {
//     provideVSCodeDesignSystem,
// 	   vsCodeButton
// } from "@vscode/webview-ui-toolkit";


type Exercise = {
    name: string,
    path: string,
    mode: string,
    hint: string,
    uri: Uri,
    rootFolder: vscode.WorkspaceFolder,
};

enum ExerciseStatus {
    inProgress,
    success,
    done
}

enum NextExerciseStatus {
    none,
    error,
    found
}

type NextExerciseReturnType = {
    status: NextExerciseStatus,
    nextExercise: Exercise | undefined,
    uri: Uri | undefined
};

export async function activate(context: vscode.ExtensionContext) {

//    provideVSCodeDesignSystem().register(vsCodeButton());

    const provider = new RustlingsHelperViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(RustlingsHelperViewProvider.viewType, provider)
    );

    // call updateRustlingsFolders() when the workspace folders change
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            provider.updateRustlingsFolders();
        })
    );

    // since the folders can load before the extension is activated, update now.
    // do it after registering the event handler so that there's no race condition.
    await provider.updateRustlingsFolders();

    // check active editor when it changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            provider.checkActiveEditor(editor, true);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            provider.checkSavedDocument(document);
        })
    );

    // Since editors can be active before the extension is activated, check the
    // active editor now.
    provider.checkActiveEditor(vscode.window.activeTextEditor, true);

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with registerCommand
    // The commandId parameter must match the command field in package.json
    let disposable = vscode.commands.registerCommand('rustlings-helper.helloWorld', () => {
        // The code you place here will be executed every time your command is executed
        // Display a message box to the user
        vscode.window.showInformationMessage('Hello World from Rustlings Helper!');
    });
    context.subscriptions.push(disposable);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlings-helper.watch', () => {
            provider.rustlingsWatch();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlings-helper.hint', () => {
            provider.showHint();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlings-helper.done', () => {
            provider.markAsDone();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlings-helper.openNextExercise', () => {
            provider.openNextExercise();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlings-helper.readme', () => {
            provider.showReadme();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlings-helper.openExercise', () => {
            provider.openExercise();
        })
    );
}

// This method is called when your extension is deactivated
export function deactivate() { }

class RustlingsHelperViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'rustlingsHelper.view';

    public readonly iAmNotDoneRegex = /^\s*\/\/\/?\s*I\s+AM\s+NOT\s+DONE/m;

    private _view?: vscode.WebviewView;

    private _rustlingsFolders: { folder: vscode.WorkspaceFolder, exercises: Exercise[] }[] = [];

    private _watchTerminal: vscode.Terminal | undefined = undefined;

    private _autoDone: boolean = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    async getExercises(folder: vscode.WorkspaceFolder): Promise<Exercise[]> {
        try {
            // Check if info.toml exists and contains exercises
            const infoUri = Uri.joinPath(folder.uri, '/info.toml');
            const infoToml = await vscode.workspace.fs.readFile(infoUri);
            const info = toml.parse(infoToml.toString());
            if (info.exercises === undefined) {
                return [];
            }

            // Just to be extra thorough, check Cargo.toml exists and has
            // "rustlings" as the package.name
            const cargoUri = Uri.joinPath(folder.uri, '/Cargo.toml');
            const cargoToml = await vscode.workspace.fs.readFile(cargoUri);
            const cargo = toml.parse(cargoToml.toString());
            if (cargo.package === undefined) {
                return [];
            }
            if (cargo.package.name !== 'rustlings') {
                return [];
            }
            return info.exercises.map((exercise: any): Exercise => {
                const markdown = markdownit({ linkify: true });
                const hint = markdown.render(exercise.hint);
                const readmeUri = Uri.joinPath(folder.uri, exercise.path, 'README.md');
                return {
                    name: exercise.name,
                    path: exercise.path,
                    mode: exercise.mode,
                    hint: hint,
                    uri: Uri.joinPath(folder.uri, exercise.path),
                    rootFolder: folder,
                };
            });
        } catch (error) {
            // Reading files failed, so this isn't a rustlings folder
            return [];
        }
    }

    public async updateRustlingsFolders() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders === undefined) {
            this._rustlingsFolders = [];
        } else {
            // Because filter() requires a synchronous function, we can't use
            // getExercises() directly. Instead, we use map() to create an array of
            // promises, then use Promise.all() to wait for all of them to resolve.
            let foldersPromises = workspaceFolders.map(async (folder) => {
                return { folder: folder, exercises: await this.getExercises(folder) };
            });
            this._rustlingsFolders = (await Promise.all(foldersPromises))
                .filter((folder) => folder.exercises.length > 0);
        }
        vscode.commands.executeCommand('setContext', 'rustlings-helper:hasRustlings', this._rustlingsFolders.length > 0);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,
            // Only allow the webview to access resources in our extension's view directory
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'view'),
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'watch':
                    this.rustlingsWatch();
                    break;
                case 'done':
                    this.markAsDone();
                    break;
                case 'infoRequest':
                    const editor = vscode.window.activeTextEditor;
                    if (editor === undefined) {
                        return;
                    }
                    this.checkSavedDocument(editor.document, true);
                    break;
                case 'autoDone':
                    this._autoDone = data.value;
                    break;
                case 'readme':
                    this.showReadme();
                    break;
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'view', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'view', 'main.css'));

        const nonce = generateNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <!--
                    Use a content security policy to only allow loading images from https or from our extension directory,
                    and only allow scripts that have a specific nonce.
                -->
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
                <title>Rustlings Helper</title>
            </head>
            <body>
                <div id="root">
                    <div id="info">
                        Exercise: <div id="exercise-name">loading...</div><br>
                        Status: <div id="exercise-status">loading...</div><br>
                        Hint: <div id="exercise-hint"></div><br>
                    </div>
                    <input type="checkbox" id="autodone-checkbox" title="Automatically mark the file as done when it compiles/passes tests, so that the next exercise will open">
                    <label for="autodone-checkbox" title="Automatically mark the file as done when it compiles/passes tests, so that the next exercise will open">Automatically mark as done</label><br>
                    <button id="watch-button" title="Run the \`rustlings watch\` command in a terminal">Watch</button><br>
                    <button id="readme-button">Show Readme</button><br>
                    <button id="hint-button">Show Hint</button><br>
                    <button id="done-button">Mark as Done</button><br>
                </div>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }

    public async checkActiveEditor(editor: vscode.TextEditor | undefined, keepOpen: boolean = false) {
        const exercise = editor ? this.exerciseInfo(editor.document.uri) : undefined;
        vscode.commands.executeCommand('setContext', 'rustlings-helper:exerciseOpen', exercise !== undefined);
        if (exercise !== undefined) {
            this.checkSavedDocument(editor!.document, keepOpen);
        }
    }

    public async markAsDone() {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined) {
            return;
        }
        const document = editor.document;
        if (!this.exerciseInfo(document.uri)) {
            vscode.window.showErrorMessage('This file is not part of a rustlings exercise');
            return;
        }
        if (document.isDirty) {
            vscode.window.showErrorMessage('Please save your file before marking it as done');
            return;
        }
        let text = document.getText();
        let matches = text.match(this.iAmNotDoneRegex);
        if (matches === null) {
            vscode.window.showInformationMessage('This file is already marked as done');
            return;
        }
        while (matches !== null) {
            const start = text.indexOf(matches[0]);
            const deleteRange = new vscode.Range(
                document.positionAt(start),
                document.positionAt(start + matches[0].length)
            );
            await editor.edit((editBuilder) => {
                editBuilder.delete(deleteRange);
            });
            text = document.getText();
            matches = text.match(this.iAmNotDoneRegex);
        }
        await document.save();
    }

    public rustlingsWatch() {
        if (this._watchTerminal === undefined || this._watchTerminal.exitStatus !== undefined) {
            if (this._watchTerminal?.exitStatus) {
                this._watchTerminal.dispose();
            }
            this._watchTerminal = vscode.window.createTerminal('Rustlings Watch', 'rustlings', ['watch']);
        }
        this._watchTerminal.show();
    }

    public exerciseInfo(uri: Uri): Exercise | undefined {
        const rustlings = this._rustlingsFolders.find((rustlings) => {
            let folder = rustlings.folder;
            // Instead of checking whether everything is the same, construct a URI
            // with the same path as the document, using the folder's URI. Then
            // compare the two URIs in string form. This is necessary because there
            // are private fields that might differ because they're caches.
            const pathIntoFolderUri = folder.uri.with({ path: uri.path });
            return uri.path.startsWith(folder.uri.path) && (pathIntoFolderUri.toString() === uri.toString());
        });
        if (rustlings === undefined) {
            return undefined;
        }
        const exercise = rustlings.exercises.find((exercise) => {
            // We already know that everything else matches, so just check the path.
            return uri.path === exercise.uri.path;
        });
        // Can be undefined
        return exercise;
    }

    public async showHint() {
        this._view?.webview.postMessage({ type: 'hint' });
    }

    public async getNextExercise(): Promise<NextExerciseReturnType> {
        const rustlings = this._rustlingsFolders[0];
        const folder = rustlings.folder;
        const command = 'rustlings list --names --unsolved';
        const list = await child_process_promise.exec(command, { cwd: folder.uri.fsPath });
        if (list.childProcess.exitCode !== 0) {
            vscode.window.showErrorMessage('Could not get next exercise!\n`'
                + command + '` exited with code ' + list.childProcess.exitCode + '\n'
                + 'stdout: ' + list.stdout + '\nstderr: ' + list.stderr);
            return { status: NextExerciseStatus.error, nextExercise: undefined, uri: undefined };
        }
        const nextExerciseName = list.stdout.split('\n')[0];
        if (nextExerciseName.startsWith('Progress: You completed')) {
            vscode.commands.executeCommand('setContext', 'rustlings-helper:allDone', true);
            return { status: NextExerciseStatus.none, nextExercise: undefined, uri: undefined };
        }
        vscode.commands.executeCommand('setContext', 'rustlings-helper:allDone', false);
        const nextExercise = rustlings.exercises.find((exercise) => exercise.name === nextExerciseName);
        if (nextExercise === undefined) {
            vscode.window.showErrorMessage(`Could not find '${nextExerciseName}' in exercises`);
            return { status: NextExerciseStatus.error, nextExercise: undefined, uri: undefined };
        }
        return {
            status: NextExerciseStatus.found,
            nextExercise: nextExercise,
            uri: Uri.joinPath(folder.uri, nextExercise.path)
        };
    }

    public async openNextExercise() {
        const nextExercise = await this.getNextExercise();
        switch (nextExercise.status) {
            case NextExerciseStatus.none:
                vscode.window.showInformationMessage('You finished all the exercises!');
                break;
            case NextExerciseStatus.error:
                break;
            case NextExerciseStatus.found:
                vscode.workspace.openTextDocument(nextExercise.uri!)
                    .then((document) => {
                        vscode.window.showTextDocument(document);
                    });
                break;
        }
    }

    public async openExercise() {
        const rustlings = this._rustlingsFolders[0];
        // show picker with all exercises
        class ExercisePickerItem implements vscode.QuickPickItem {
            public readonly label: string = this.exercise.path.replace(/exercises\//, '');
            public readonly description: string = this.exercise.name;
            constructor(public readonly exercise: Exercise) { }
            // TODO: show status in detail field
            // Would require checking the status of each exercise, which is
            // too slow to do here, so needs to be done at extension startup
            // and then tracked throughout.
        }

        const pickItems = rustlings.exercises.map((exercise) => new ExercisePickerItem(exercise));
        const picked = await vscode.window.showQuickPick(pickItems);
        if (picked === undefined) {
            return;
        }
        const exercise = picked.exercise;
        if (exercise === undefined) {
            vscode.window.showErrorMessage(`Could not find '${picked}' in exercises`);
            return;
        }
        const document = await vscode.workspace.openTextDocument(exercise.uri);
        vscode.window.showTextDocument(document);
    }

    public async checkSavedDocument(document: vscode.TextDocument, keepOpen: boolean = false) {
        const exercise = this.exerciseInfo(document.uri);
        if (exercise === undefined) {
            // If it's not an exercise, we don't care
            return;
        }
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor?.document === document) {
            this._view?.webview.postMessage({ type: 'exercise', exercise: exercise, status: 'verifying...' });
        }
        const text = document.getText();
        const exerciseMarkedDone = text.match(this.iAmNotDoneRegex) === null;
        // Check that it compiles
        const folder = exercise.rootFolder;
        child_process.exec('rustlings run ' + exercise.name, { cwd: folder.uri.fsPath }, (error, stdout, stderr) => {
            console.log('stdout: ', stdout);
            console.log('stderr: ', stderr);
            let status;
            if (error) {
                status = ExerciseStatus.inProgress;
            } else if (exerciseMarkedDone) {
                status = ExerciseStatus.done;
            } else {
                status = ExerciseStatus.success;
            }
            // 
            if (status !== ExerciseStatus.done) {
                vscode.commands.executeCommand('setContext', 'rustlings-helper:allDone', false);
            }
            // If the active editor changed while we were running, don't do
            // anything. We don't want to automatically mark as Done if the
            // user isn't looking at the file when saving. Neither do we want
            // to close and open the next exercise. And of course, don't update
            // the webview.
            if (vscode.window.activeTextEditor !== activeEditor) {
                return;
            }
            let statusMessage;
            switch (status) {
                case ExerciseStatus.inProgress:
                    statusMessage = 'In progress';
                    break;
                case ExerciseStatus.success:
                    statusMessage = 'Compiles/passes tests but not marked as Done';
                    if (this._autoDone) {
                        this.markAsDone();
                    }
                    break;
                case ExerciseStatus.done:
                    statusMessage = 'Done';
                    break;
            }
            // Send this before doing anything else, to avoid sending these
            // out of order. Very unlikely, but doesn't hurt to be safe.
            this._view?.webview.postMessage({
                type: 'exercise',
                exercise: exercise,
                status: statusMessage
            });
            if (status === ExerciseStatus.success && this._autoDone) {
                this.markAsDone();
            } else if (status === ExerciseStatus.done && !keepOpen) {
                vscode.window.showInformationMessage('You finished ' + exercise.name + '!');
                vscode.commands.executeCommand('workbench.action.closeActiveEditor')
                    .then(() => {
                        this.openNextExercise();
                    });
            }
        });
    }

    public showReadme() {
        const document = vscode.window.activeTextEditor?.document;
        if (document === undefined) {
            return;
        }
        const documentUri = document.uri;
        const readmeUri = Uri.joinPath(documentUri, '../README.md');
        vscode.workspace.openTextDocument(readmeUri)
            .then((document) => {
                vscode.window.showTextDocument(document);
            });
    }
}

function generateNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

