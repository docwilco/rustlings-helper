import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as child_process_promise from 'child-process-promise';
import { assert } from 'console';
import { ExerciseTreeLeaf } from './rustlingsExercisesProvider';

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
        public uri: Uri,
        public rootFolder: vscode.WorkspaceFolder
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
        this.done = done;
        this.treeItem?.update();
    }

    public async run(): Promise<boolean> {
        const cwd = this.rootFolder.uri.fsPath;
        const command = 'rustlings run ' + this.name;
        try {
            const result = await child_process_promise.exec(command, { cwd: cwd });
            this.success = true;
        } catch (error) {
            this.success = false;
        }
        this.treeItem?.update();
        return this.success;
    }
}
