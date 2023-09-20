// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { RustlingsExercisesProvider } from './rustlingsExercisesProvider';
import { RustlingsMarkdownPanel } from './rustlingsMarkdownPanel';

export async function activate(context: vscode.ExtensionContext) {

    const treeProvider = new RustlingsExercisesProvider();
    context.subscriptions.push(treeProvider);

    const treeView = vscode.window.createTreeView(
        'rustlingsHelper.exercisesView',
        {
            treeDataProvider: treeProvider,
            manageCheckboxStateManually: true,
        }
    );
    context.subscriptions.push(treeView);
    treeProvider.setView(treeView);

    // call updateRustlingsFolders() when the workspace folders change
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            treeProvider.updateRustlingsFolders();
        })
    );
    // since the folders can load before the extension is activated, update now.
    // do it after registering the event handler so that there's no race
    // condition.
    await treeProvider.updateRustlingsFolders();

    const watcher = vscode.workspace.createFileSystemWatcher(
        '**/exercises/**/*.rs'
    );
    context.subscriptions.push(watcher);
    context.subscriptions.push(
        watcher.onDidChange((uri) => {
            treeProvider.queueExerciseRunByUri(uri);
        })
    );

    // Setup events for Watch Terminal
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal((terminal) => {
            treeProvider.terminalClosed(terminal);
        })
    );
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTerminal((terminal) => {
            treeProvider.activeTerminalChanged(terminal);
        })
    );
    // Since we should only activate if there's a Rustlings folder, kick off the
    // Watch automatically.
    treeProvider.rustlingsWatch();

    // check active editor when it changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            treeProvider.checkActiveEditor(editor);
            RustlingsMarkdownPanel.activeEditorChanged(editor);
        })
    );

    // Since editors can be active before the extension is activated, check the
    // active editor now.
    treeProvider.checkActiveEditor(vscode.window.activeTextEditor);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlingsHelper.watch', async () => {
            await treeProvider.rustlingsWatch();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlingsHelper.toggleDone', () => {
            treeProvider.toggleDone();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'rustlingsHelper.openNextExercise', () => {
                treeProvider.openNextExercise();
            }
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlingsHelper.openExercise', () => {
            treeProvider.openExercise();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlingsHelper.showHint', () => {
            RustlingsMarkdownPanel.render(
                context.extensionUri,
                treeProvider,
                'hint',
            );
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlingsHelper.showReadme', () => {
            RustlingsMarkdownPanel.render(
                context.extensionUri,
                treeProvider,
                'readme',
            );
        })
    );
}

// This method is called when your extension is deactivated
export function deactivate() { }
