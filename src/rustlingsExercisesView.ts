import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as toml from 'toml';
import MarkdownIt from 'markdown-it';
import * as child_process from 'child_process';
import * as child_process_promise from 'child-process-promise';

enum ExerciseStatus {
    checking,
    inProgress,
    success,
    done
}

type Exercise = {
    name: string,
    path: string,
    mode: string,
    hintHtml: string,
    status: ExerciseStatus,
    uri: Uri,
    rootFolder: vscode.WorkspaceFolder,
};

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

type RustlingsFolder = {
    folder: vscode.WorkspaceFolder,
    exercises: Exercise[],
    exercisesMap: Map<string, Exercise>
};

export class RustlingsExercisesProvider implements vscode.TreeDataProvider<string> {
    private _onDidChangeTreeData: vscode.EventEmitter<string | undefined> = new vscode.EventEmitter<string | undefined>();
    readonly onDidChangeTreeData: vscode.Event<string | undefined> = this._onDidChangeTreeData.event;

    private _rustlingsFolders: RustlingsFolder[] = [];

    private _watchTerminal: vscode.Terminal | undefined = undefined;

    private _autoDone: boolean = false;

    private readonly iAmNotDoneRegex = /^\s*\/\/\/?\s*I\s+AM\s+NOT\s+DONE/m;

    constructor() {

    }

    public dispose() {
        this._onDidChangeTreeData.dispose();
    }

    private async _getExercises(folder: vscode.WorkspaceFolder): Promise<Exercise[]> {
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
                const markdown = MarkdownIt({ linkify: true });
                const hintHtml = markdown.render(exercise.hint);
                return {
                    name: exercise.name,
                    path: exercise.path,
                    mode: exercise.mode,
                    hintHtml: hintHtml,
                    status: ExerciseStatus.checking,
                    uri: Uri.joinPath(folder.uri, exercise.path),
                    rootFolder: folder,
                };
            })
                .filter((exercise: Exercise) => {
                    const pathElements = exercise.path.split('/');
                    const length = pathElements.length;
                    if (length < 2 || length > 3
                        || pathElements[0] !== 'exercises'
                        || exercise.path.endsWith('/')) {
                        vscode.window.showErrorMessage(`Invalid exercise path: ${exercise.path} in info.toml`);
                        return false;
                    }
                    return true;
                });
        } catch (error) {
            // Reading files failed, so this isn't a rustlings folder
            return [];
        }
    }

    private _exerciseInfo(uri: Uri): Exercise | undefined {
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

    async updateRustlingsFolders() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders === undefined) {
            this._rustlingsFolders = [];
        } else {
            // Because filter() requires a synchronous function, we can't use
            // getExercises() directly. Instead, we use map() to create an array of
            // promises, then use Promise.all() to wait for all of them to resolve.
            let foldersPromises = workspaceFolders.map(async (folder) => {
                return { folder: folder, exercises: await this._getExercises(folder) };
            });
            this._rustlingsFolders = (await Promise.all(foldersPromises))
                .filter((folder) => folder.exercises.length > 0)
                .map((folder) => {
                    let exercisesMap = new Map<string, Exercise>();
                    folder.exercises.forEach((exercise) => {
                        exercisesMap.set(exercise.name, exercise);
                    });
                    return { folder: folder.folder, exercises: folder.exercises, exercisesMap: exercisesMap };
                });
        }
        vscode.commands.executeCommand('setContext', 'rustlings-helper:hasRustlings', this._rustlingsFolders.length > 0);
        this._onDidChangeTreeData.fire(undefined);
    }

    getChildren(path?: string): string[] | undefined {
        console.log('getChildren: ', path);
        if (path === undefined) {
            switch (this._rustlingsFolders.length) {
                case 0:
                    return undefined;
                case 1:
                    // If there's only one rustlings folder, show its exercises
                    return this.getChildren("0/");
                default:
                    // If there are multiple rustlings folders, show them
                    return this._rustlingsFolders.map((folder, index) => index.toString() + '/');
                // The above returns:
                //   <rustlingsFolderIndex>/
            }
        }
        const pathElements = path.split('/');
        const rustlingsFolderIndex = parseInt(pathElements[0]);
        if (isNaN(rustlingsFolderIndex) || rustlingsFolderIndex >= this._rustlingsFolders.length) {
            return undefined;
        }
        const rustlingsFolder = this._rustlingsFolders[rustlingsFolderIndex];
        // If we're here, path is one of the following:
        //   <rustlingsFolderIndex>/
        //   <rustlingsFolderIndex>/<section>/
        //   <rustlingsFolderIndex>/<section>/<exercise>
        //   <rustlingsFolderIndex>/<exercise>
        // The last being for the quizzes.
        // This should result in the following pathElements:
        //   ['<rustlingsFolderIndex>', '']
        //   ['<rustlingsFolderIndex>', '<section>', '']
        //   ['<rustlingsFolderIndex>', '<section>', '<exercise>']
        //   ['<rustlingsFolderIndex>', '<exercise>']
        // If the path doesn't end in a slash, it's an exercise, so return
        // empty.
        if (!path.endsWith('/')) {
            return [];
        }
        // We're here, so pop the empty element off the end
        pathElements.pop();
        if (pathElements.length === 1) {
            // If there's only one element, show the sections and quizzes
            return rustlingsFolder.exercises
                // turn exercises/intro/1.rs into 0/intro/
                // turn exercises/intro/quiz1.rs into 0/quiz1.rs
                .map((exercise) => {
                    const exercisePathElements = exercise.path.split('/');
                    const length = exercisePathElements.length;
                    return pathElements[0] + '/' + exercisePathElements[1]
                        + (length === 3 ? '/' : '');
                    // The above returns either:
                    //   <rustlingsFolderIndex>/<section>/
                    // or:
                    //   <rustlingsFolderIndex>/<quiz>
                })
                // Sections will be repeated for each exercise in them, so
                // remove duplicates
                .reduce((unique: string[], path) => {
                    if (!unique.includes(path)) {
                        unique.push(path);
                    }
                    return unique;
                }, []);
        }
        if (pathElements.length === 2) {
            // If there are two elements, show the exercises in the section
            const sectionPath = `exercises/${pathElements[1]}/`;
            return rustlingsFolder.exercises
                .filter((exercise) => exercise.path.startsWith(sectionPath))
                .map((exercise) => {
                    const exercisePathElements = exercise.path.split('/');
                    return pathElements[0] + '/' + exercisePathElements[1]
                        + '/' + exercisePathElements[2];
                    // The above returns
                    //   <rustlingsFolderIndex>/<section>/<exercise>
                });
        }
    }


    // If there is only one Rustlings folder, the possible inputs are:
    //   <rustlingsFolderIndex>/<section>/
    //   <rustlingsFolderIndex>/<section>/<exercise>
    //   <rustlingsFolderIndex>/<exercise>
    //
    // and they should result in:
    //   undefined (root)
    //   <rustlingsFolderIndex>/<section>/
    //   undefined (root)
    // 
    // If there are multiple Rustlings folders, the possible inputs are:
    //   <rustlingsFolderIndex>/
    //   <rustlingsFolderIndex>/<section>/
    //   <rustlingsFolderIndex>/<section>/<exercise>
    //   <rustlingsFolderIndex>/<exercise>
    //
    // and they should result in:
    //   undefined (root)
    //   <rustlingsFolderIndex>/
    //   <rustlingsFolderIndex>/<section>/
    //   <rustlingsFolderIndex>/
    getParent(path: string): string | undefined {
        // Splits `0/intro/intro1.rs` into ['0/', 'intro/', 'intro1.rs']
        // and `0/intro/` into ['0/', 'intro/']
        let pathElements = path.split(/(?<=\/)/);
        // Remove the last
        pathElements.pop();
        // If there's only one Rustlings folder, the parent of 0/intro/ is the
        // root, instead of 0/, so return undefined if there's only one element
        // left
        if (this._rustlingsFolders.length < 2 && pathElements.length === 1) {
            return undefined;
        }
        if (pathElements.length === 0) {
            // If there's nothing left, return undefined
            return undefined;
        }
        // Join back together
        return pathElements.join('');
    }

    getTreeItem(path: string): vscode.TreeItem {
        const pathElements = path.split('/').filter((element) => element !== '');
        const rustlingsFolderIndex = parseInt(pathElements.shift()!);
        if (isNaN(rustlingsFolderIndex) || rustlingsFolderIndex >= this._rustlingsFolders.length) {
            return new vscode.TreeItem("error?!", undefined);
        }
        const rustlingsFolder = this._rustlingsFolders[rustlingsFolderIndex];
        if (path.endsWith('/')) {
            // If it's `<index>/<section>/`, just use `<section>`
            // pathElements can only be ['<section>'] or [] here because we
            // shift()ed above.            
            if (pathElements.length === 1) {
                return new vscode.TreeItem(pathElements.pop()!, vscode.TreeItemCollapsibleState.Collapsed);
            }
            // Can only be `<index>/`, return the folder name
            return new vscode.TreeItem(rustlingsFolder.folder.name, vscode.TreeItemCollapsibleState.Collapsed);
        }
        // pathElements can only be ['<section>', '<exercise>'] or ['<exersize>']
        // right now
        const exercisePath = 'exercises/' + pathElements.join('/');
        const exercise = rustlingsFolder.exercises.find((exercise) => exercise.path === exercisePath);
        return new vscode.TreeItem(exercise!.name);
    }

    rustlingsWatch() {
        if (this._rustlingsFolders.length === 0) {
            return;
        }
        // TODO: support multiple folders for Watch
        const cwd = this._rustlingsFolders[0].folder.uri.fsPath;
        if (this._watchTerminal === undefined || this._watchTerminal.exitStatus !== undefined) {
            if (this._watchTerminal?.exitStatus) {
                this._watchTerminal.dispose();
            }
            this._watchTerminal = vscode.window.createTerminal({
                name: 'Rustlings Watch',
                cwd: cwd,
                shellPath: 'rustlings',
                shellArgs: ['watch']
            });
        }
        this._watchTerminal.show();
    }

    terminalClosed(terminal: vscode.Terminal) {
        if (terminal !== this._watchTerminal) {
            return;
        }
        this._watchTerminal = undefined;
    }

    activeTerminalChanged(terminal: vscode.Terminal | undefined) {
        const watching = terminal !== undefined
            && terminal === this._watchTerminal;
        console.log('watching: ', watching);
        vscode.commands.executeCommand(
            'setContext',
            'rustlings-helper:watching',
            watching
        );
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
        const exercise = this._exerciseInfo(document.uri);
        if (exercise === undefined) {
            // If it's not an exercise, we don't care
            return;
        }
        const activeEditor = vscode.window.activeTextEditor;
        let status = ExerciseStatus.checking;
        // TODO: update status so it's visible in the tree view
        const text = document.getText();
        const exerciseMarkedDone = text.match(this.iAmNotDoneRegex) === null;
        // Check that it compiles
        const folder = exercise.rootFolder;
        child_process.exec('rustlings run ' + exercise.name, { cwd: folder.uri.fsPath }, (error, stdout, stderr) => {
            // console.log('stdout: ', stdout);
            // console.log('stderr: ', stderr);
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
            // TODO: send status to treeview
            // Send this before doing anything else, to avoid sending these
            // out of order. Very unlikely, but doesn't hurt to be safe.
            if (status === ExerciseStatus.success && this._autoDone) {
                this.toggleDone();
            } else if (status === ExerciseStatus.done && !keepOpen) {
                vscode.window.showInformationMessage('You finished ' + exercise.name + '!');
                vscode.commands.executeCommand('workbench.action.closeActiveEditor')
                    .then(() => {
                        this.openNextExercise();
                    });
            }
        });
    }

    public async checkActiveEditor(
        editor: vscode.TextEditor | undefined,
        keepOpen: boolean = false
    ) {
        const exercise = editor ? this._exerciseInfo(editor.document.uri) : undefined;
        vscode.commands.executeCommand(
            'setContext',
            'rustlings-helper:exerciseOpen',
            exercise !== undefined
        );
        if (exercise !== undefined) {
            this.checkSavedDocument(editor!.document, keepOpen);
        }
    }

    public async toggleDone() {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined) {
            return;
        }
        const document = editor.document;
        if (!this._exerciseInfo(document.uri)) {
            vscode.window.showErrorMessage('This file is not part of a rustlings exercise');
            return;
        }
        if (document.isDirty) {
            vscode.window.showErrorMessage('Please save your file before marking it as done/not done');
            return;
        }
        let text = document.getText();
        let matches = text.match(this.iAmNotDoneRegex);
        if (matches === null) {
            // Document is marked as done, so mark it as not done by adding the
            // comment at the top.
            await editor.edit((editBuilder) => {
                editBuilder.insert(new vscode.Position(0, 0), '// I AM NOT DONE\n');
            });
            await document.save();
            return;
        }
        // Document is marked as not done, so mark it as done by removing the
        // markers.
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

    async showHint() {
        // TODO
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

