// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as child_process from 'child_process';
import * as child_process_promise from 'child-process-promise';
import MarkdownIt from 'markdown-it';

import { RustlingsExercisesProvider } from './rustlingsExercisesView';



export async function activate(context: vscode.ExtensionContext) {

    const provider = new RustlingsExercisesProvider();
    context.subscriptions.push(provider);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('rustlingsHelper.exercisesView', provider)
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

    // Setup events for Watch Terminal
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal((terminal) => {
            provider.terminalClosed(terminal);
        })
    );
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTerminal((terminal) => {
            provider.activeTerminalChanged(terminal);
        })
    );
    // Since we should only activate if there's a Rustlings folder, kick off the
    // Watch automatically.
    provider.rustlingsWatch();

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
        vscode.commands.registerCommand('rustlings-helper.toggleDone', () => {
            provider.toggleDone();
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

function generateNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

