import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { assert } from 'console';
import { ExerciseTreeLeaf } from './rustlingsExercisesProvider';
import { RustlingsFolder } from './rustlingsFolder';
import * as child_process from 'child_process';
import { promisify } from 'util';

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

    public async run(): Promise<boolean> {
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
        if (vscode.window.activeTextEditor?.document.uri.toString() === this.uri.toString()) {
            this.printRunOutput();
        }
        return this.success === true;
    }

    public async printRunOutput() {
        if (this.runStdout === undefined && this.runStderr === undefined) {
            return;
        }
        const pty = this.rustlingsFolder?.pty;
        if (pty === undefined) {
            return;
        }
        await vscode.commands.executeCommand(
            'workbench.action.terminal.clear'
        );
        let output = this.runStdout ?? '' + this.runStderr ?? '';
        output = output.replace(/\n/g, '\r\n');
        pty.write(output);
        pty.show;
        vscode.commands.executeCommand(
            'workbench.action.terminal.scrollToTop'
        );
    }
}
