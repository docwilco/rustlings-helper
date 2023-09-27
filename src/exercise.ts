import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { assert } from 'console';
import { ExerciseTreeLeaf } from './rustlingsExercisesProvider';
import { RustlingsFolder } from './rustlingsFolder';
import * as child_process from 'child_process';
import { promisify } from 'util';
import { Chalk } from 'chalk';
import { showWalkthroughForExercise } from './walkthroughSteps';

const chalk = new Chalk({ level: 1 });
const red = chalk.red;
const green = chalk.green;
const blue = chalk.blue;
const bold = chalk.bold;

const execAsync = promisify(child_process.exec);
const timeoutPromise = promisify(setTimeout);

export async function readTextFile(uri: Uri): Promise<string> {
    // Don't use vscode.workspace.openTextDocument() because we write to
    // the file raw, and our change event handler gets the event before
    // the document is updated.
    const fileBytes = await vscode.workspace.fs.readFile(uri);
    const buffer = Buffer.from(fileBytes);
    return buffer.toString();
}

async function writeTextFile(uri: Uri, text: string): Promise<void> {
    const buffer = Buffer.from(text);
    await vscode.workspace.fs.writeFile(uri, buffer);
}

export class Exercise {
    // For these two, undefined means we don't know yet
    success?: boolean;
    done?: boolean;
    runStdout?: string;
    runStderr?: string;
    treeItem?: ExerciseTreeLeaf;

    // Global flag (/g) so that `replace()` will match all instances
    // `(\r?\n)?` to match either Windows or Unix line endings optionally
    public static readonly iAmNotDoneRegex =
        /^\s*\/\/\/?\s*I\s+AM\s+NOT\s+DONE(\r?\n)?/mg;

    constructor(
        public name: string,
        public path: string,
        public mode: string,
        public hintHtml: string,
        public readmeHtml: string,
        public uri: Uri,
        public rootFolder: vscode.WorkspaceFolder,
        public rustlingsFolder?: RustlingsFolder,
    ) { }

    private async _askToSaveForDone(
        document: vscode.TextDocument,
        done: boolean
    ): Promise<boolean> {
        const message = document.uri.path.split('/').pop()
            + ' needs to be saved before it can be marked as '
            + (done ? 'done.' : 'not done.');
        const save = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            'Save now'
        );
        if (save !== 'Save now') {
            return false;
        }
        await document.save();
        assert(!document.isDirty);
        return true;
    }

    public async markDone(done: boolean) {
        const uri = this.uri;
        // Check if the exercise is an open document
        const document = vscode.workspace.textDocuments.find(
            (document) => document.uri.toString() === uri.toString()
        );
        // If the document is open and dirty, prompt the user to save it before
        // marking it as done/not done.
        if (document?.isDirty) {
            const saved = await this._askToSaveForDone(document, done);
            if (!saved) {
                // User cancelled, update so that the checkbox is reverted
                // if the click changed it.
                this.treeItem?.update();
                return;
            }
        }
        assert(document === undefined || !document.isDirty);
        // If the document isn't open or isn't dirty, just do raw file access.
        // If there is an editor open for it, it will update automatically. If
        // there isn't, we don't want to open one, needlessly.
        let text = await readTextFile(this.uri);
        if (done) {
            text = text.replace(Exercise.iAmNotDoneRegex, '');
        } else {
            // Determine EOL style
            // Is this overkill? Maybe.
            const windowsEol = text.match(/\r\n/g)?.length ?? 0;
            const unixEol = text.match(/(?<!\r)\n/g)?.length ?? 0;
            const eol = windowsEol > unixEol ? '\r\n' : '\n';
            text = '// I AM NOT DONE' + eol + text;
        }
        await writeTextFile(this.uri, text);
        this.treeItem?.update();
    }

    public async run() {
        const previousSuccess = this.success;
        const previousDone = this.done;
        this.success = undefined;
        this.done = undefined;
        this.treeItem?.update();

        try {
            const text = await readTextFile(this.uri);
            this.done = text.match(Exercise.iAmNotDoneRegex) === null;
        } catch (error) {
            // If we can't read the file, we can't run it
            this.success = false;
            this.done = false;
            this.treeItem?.update();
            return;
        }
        this.treeItem?.update();

        const cwd = this.rootFolder.uri.fsPath;
        const command = 'rustlings run ' + this.name;
        await execAsync(
            command,
            { cwd: cwd }
        ).then((result) => {
            this.runStdout = result.stdout;
            this.runStderr = result.stderr;
            this.success = true;
        }).catch((error) => {
            this.runStdout = error.stdout;
            this.runStderr = error.stderr;
            this.success = false;
        });
        this.treeItem?.update();

        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor?.document.uri.toString() !== this.uri.toString()) {
            return;
        }
        this.printRunOutput();
        await showWalkthroughForExercise(this);

        if (this.success && this.done && (!previousSuccess || !previousDone)) {
            vscode.window.showInformationMessage(
                'You finished ' + this.name + '!'
            );
            this.rustlingsFolder!.provider.openNextExercise(this, activeEditor);
        }
    }

    private async _getNotDoneWithContext(): Promise<string> {
        // File should be open, or we wouldn't be calling this method
        const document = vscode.window.activeTextEditor?.document;
        let text = document?.getText();
        if (document === undefined || document.uri.toString() !== this.uri.toString()) {
            text = await readTextFile(this.uri);
        }
        const lines = text!.split(/\r?\n/).map((line, index) => {
            return { text: line, index: index };
        });
        const notDoneLine = lines.find((line) => line.text.match(Exercise.iAmNotDoneRegex));
        if (notDoneLine === undefined) {
            return '';
        }
        const startLine = Math.max(0, notDoneLine.index - 2);
        const endLine = Math.min(lines.length - 1, notDoneLine.index + 2);
        let output = '';
        for (let i = startLine; i <= endLine; i++) {
            const lineNumber = (i + 1).toString().padStart(2) + ' |  ';
            const lineTextRaw = lines[i]!.text;
            const lineText = i === notDoneLine.index ? bold(lineTextRaw) : lineTextRaw;
            output += blue(lineNumber) + lineText + '\r\n';
        }
        return output;
    }

    private async _recreateRustlingsOutput(): Promise<string> {
        // Or at least... approximate
        if (this.success === undefined || this.done === undefined) {
            return `Checking exercise ${this.name}...`;
        }
        const stdout = this.runStdout?.split(/\r?\n/).filter((line) =>
            line.search('Successfully ran ') === -1
        ).map((line) => {
            if (line.search(/(Test|Compil)(ing|ation) of .* failed!/) !== -1) {
                return red(line);
            }
            if (line.search(/Ran .* with errors/) !== -1) {
                return red(line);
            }
            return line;
        }).join('\r\n');
        const stderr = this.runStderr?.replace(/\n/g, '\r\n');
        if (!this.success) {
            return stdout + `\r\n` + stderr;
        }
        let part1;
        let part2;
        switch (this.mode) {
            case 'compile':
                part1 = `Successfully ran ${this.name}!`;
                part2 = 'The code is compiling!';
                break;
            case 'test':
                part1 = `Successfully tested ${this.name}!`;
                part2 = 'The code is compiling, and the tests pass!';
                break;
            case 'clippy':
                part1 = `Successfully compiled ${this.name}!`;
                part2 = `The code is compiling, and 📎 Clippy 📎 is happy!`;
                break;
            default:
                part1 = '';
                part2 = `Please report a bug in the Rustlings Helper VSCode extension: unknown mode ${this.mode}`;
        }
        part1 = green('✅ ' + part1);
        let output = part1 + '\r\n🎉 🎉  ' + part2 + ' 🎉 🎉\r\n\r\n';
        const separator = bold('====================\r\n');
        if (stdout !== undefined && stdout !== '') {
            output += 'Output:\r\n';
            output += separator;
            output += stdout + '\r\n';
            if (stderr !== undefined && stderr !== '') {
                output += stderr + '\r\n';
            }
            while (output.endsWith('\r\n\r\n')) {
                output = output.slice(0, -2);
            }
            output += separator + '\r\n';
        }
        if (!this.done) {
            output += 'You can keep working on this exercise,\r\n'
                + `or jump into the next one by removing the ${bold('I AM NOT DONE')} comment.\r\n\r\n`;
            output += await this._getNotDoneWithContext();
        }
        return output;
    }

    public async printRunOutput() {
        if (this.runStdout === undefined && this.runStderr === undefined) {
            return;
        }
        const pty = this.rustlingsFolder?.pty;
        if (pty === undefined) {
            return;
        }
        if (this.done === undefined || this.success === undefined) {
            return;
        }
        pty.show();
        // Clear the terminal with RIS (full reset)
        pty.write('\x1bc');
        pty.write(await this._recreateRustlingsOutput());
        await timeoutPromise(100);
        await vscode.commands.executeCommand(
            'workbench.action.terminal.scrollToTop'
        );
    }

    public async reset() {
        const cwd = this.rootFolder.uri.fsPath;
        const command = 'rustlings reset ' + this.name;
        return execAsync(
            command,
            { cwd: cwd }
        );
    }
}
