// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as child_process from 'child_process';
import * as child_process_promise from 'child-process-promise';
import MarkdownIt from 'markdown-it';

import { RustlingsExercisesProvider } from './rustlingsExercisesProvider';

export async function activate(context: vscode.ExtensionContext) {

    const treeProvider = new RustlingsExercisesProvider();
    context.subscriptions.push(treeProvider);

    const treeView = vscode.window.createTreeView('rustlingsHelper.exercisesView', {
        treeDataProvider: treeProvider,
        manageCheckboxStateManually: true,
    });
    context.subscriptions.push(treeView);
    treeProvider.setView(treeView);

    // call updateRustlingsFolders() when the workspace folders change
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            treeProvider.updateRustlingsFolders();
        })
    );
    // since the folders can load before the extension is activated, update now.
    // do it after registering the event handler so that there's no race condition.
    await treeProvider.updateRustlingsFolders();

    const watcher = vscode.workspace.createFileSystemWatcher(
        '**/exercises/**/*.rs'
    );
    context.subscriptions.push(watcher);
    context.subscriptions.push(
        watcher.onDidChange((uri) => {
            treeProvider.fileChanged(uri);
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
        })
    );

    // Since editors can be active before the extension is activated, check the
    // active editor now.
    treeProvider.checkActiveEditor(vscode.window.activeTextEditor);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlingsHelper.watch', () => {
            treeProvider.rustlingsWatch();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlingsHelper.hint', () => {
            treeProvider.showHint();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlingsHelper.toggleDone', () => {
            treeProvider.toggleDone();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlingsHelper.openNextExercise', () => {
            treeProvider.openNextExercise();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlingsHelper.readme', () => {
            treeProvider.showReadme();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('rustlingsHelper.openExercise', () => {
            treeProvider.openExercise();
        })
    );
}

// This method is called when your extension is deactivated
export function deactivate() { }

function generateNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

