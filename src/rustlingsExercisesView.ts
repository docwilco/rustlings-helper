import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as toml from 'toml';
import MarkdownIt from 'markdown-it';
import * as child_process_promise from 'child-process-promise';
import { assert } from 'console';

type Exercise = {
    name: string,
    path: string,
    mode: string,
    hintHtml: string,
    // For these two, undefined means we don't know yet
    success?: boolean,
    done?: boolean,
    uri: Uri,
    rootFolder: vscode.WorkspaceFolder,
    treeItem?: ExerciseTreeLeaf;
};

class RustlingsFolder {
    public readonly exercisesMap: Map<string, Exercise>;
    public readonly exercisesTree: ExerciseTree;
    constructor(
        private _view: vscode.TreeView<ExerciseTreeItem>,
        public readonly folder: vscode.WorkspaceFolder,
        public readonly exercises: Exercise[]
    ) {
        this.exercisesMap = new Map<string, Exercise>();
        exercises.forEach((exercise) => {
            // Map on multiple types of keys
            this.exercisesMap.set(exercise.uri.toString(), exercise);
            this.exercisesMap.set(exercise.name, exercise);
            this.exercisesMap.set(exercise.path, exercise);
        });
        this.exercisesTree = new ExerciseTree(
            this._view,
            folder.name,
            exercises
        );
    }

    public async checkStatus(
        eventEmitter: vscode.EventEmitter<ExerciseTreeItem | undefined>
    ) {
        // Use setTimeout() to fire this off in the background, as exec()
        // doesn't seem to return until the command is done.
        setTimeout(async () => {
            const listDoneCommand = 'rustlings list --paths --solved';
            const result = await child_process_promise.exec(
                listDoneCommand,
                { cwd: this.folder.uri.fsPath }
            );
            if (result.childProcess.exitCode !== 0) {
                vscode.window.showErrorMessage(
                    `Failed to run "${listDoneCommand}": ${result.stderr}`
                );
                return;
            }
            const done = new Set(
                result.stdout.split('\n')
                    .map((line) => line.trim())
                    .filter(
                        (line) => line !== '' && !line.startsWith('Progress: ')
                    )
            );
            this.exercises.forEach((exercise) => {
                exercise.done = done.has(exercise.path);
                if (exercise.treeItem !== undefined) {
                    exercise.treeItem.update(eventEmitter);
                }
            });
        }, 1000);
        // Above is 1 second, because with less the TreeView doesn't update
        // until after the closure is done.

        setTimeout(async () => {
            const exercises = [...this.exercises];
            setTimeout(async function checkRunExercise() {
                const exercise = exercises.shift();
                if (exercise === undefined) {
                    return;
                }
                // Other events can have already updated this exercise, so
                // check if we need to run it.
                if (exercise.success === undefined) {
                    await runExercise(exercise, eventEmitter);
                }
                // We want to postpone to the next eventloop here now so that
                // the UI can update
                setTimeout(checkRunExercise);
            });
        }, 1000); // Again 1 second so updates happen
    }
};

function iconForSuccessState(success?: boolean): vscode.ThemeIcon {
    switch (success) {
        case true:
            return new vscode.ThemeIcon('thumbsup');
        case false:
            return new vscode.ThemeIcon('warning');
        case undefined:
            return new vscode.ThemeIcon('loading~spin');
    }
}

function checkboxStateForDoneState(
    done?: boolean
): vscode.TreeItemCheckboxState | undefined {
    switch (done) {
        case true:
            return vscode.TreeItemCheckboxState.Checked;
        case false:
            return vscode.TreeItemCheckboxState.Unchecked;
        case undefined:
            return undefined;
    }
}

async function runExercise(
    exercise: Exercise,
    eventEmitter?: vscode.EventEmitter<ExerciseTreeItem | undefined>
): Promise<boolean> {
    const cwd = exercise.rootFolder.uri.fsPath;
    const command = 'rustlings run ' + exercise.name;
    try {
        const result = await child_process_promise.exec(command, { cwd: cwd });
        exercise.success = true;
    } catch (error) {
        exercise.success = false;
    }
    exercise.treeItem?.update(eventEmitter);
    return exercise.success;
}

class ExerciseTreeLeaf extends vscode.TreeItem {
    success?: boolean;
    done?: boolean;
    constructor(
        public readonly parent: ExerciseTreeBranch,
        public readonly pathElement: string,
        public readonly exercise: Exercise,
    ) {
        super(exercise.name);
        exercise.treeItem = this;
        this.success = exercise.success;
        this.done = exercise.done;
        this.command = {
            command: 'vscode.open',
            title: 'Open Exercise',
            arguments: [exercise.uri]
        };
        this.update();
    }

    public update(
        eventEmitter?: vscode.EventEmitter<ExerciseTreeItem | undefined>
    ) {
        const oldIconPath = this.iconPath;
        const oldCheckboxState = this.checkboxState;
        this.iconPath = iconForSuccessState(this.exercise.success);
        this.checkboxState = checkboxStateForDoneState(this.exercise.done);
        this.success = this.exercise.success;
        this.done = this.exercise.done;
        if (oldIconPath !== this.iconPath
            || oldCheckboxState !== this.checkboxState) {
            eventEmitter?.fire(this);
        }
        this.parent.update(eventEmitter);
    }

    public markDone(provider: RustlingsExercisesProvider, done: boolean) {
        if (done === this.done) {
            // This can happen if the user clicks on the folder's checkbox and
            // and the exercise was already in the new state.
            return;
        }
        provider.markDone(this.exercise, done);
    }
}

class ExerciseTreeBranch extends vscode.TreeItem {
    children: (ExerciseTreeBranch | ExerciseTreeLeaf)[] = [];
    success?: boolean;
    done?: boolean;
    constructor(
        public readonly parent: ExerciseTreeBranch | undefined,
        public readonly pathElement: string | undefined,
        label?: string
    ) {
        if (pathElement === undefined) {
            pathElement = '';
        }
        super(
            // strip trailing slash
            label ?? pathElement?.slice(0, -1),
            vscode.TreeItemCollapsibleState.Collapsed
        );
        this.iconPath = new vscode.ThemeIcon('folder');
    }

    addExercise(pathElements: string[], exercise: Exercise) {
        if (pathElements.length === 0) {
            return;
        } else if (pathElements.length === 1) {
            this.children.push(
                new ExerciseTreeLeaf(this, pathElements[0], exercise)
            );
        } else {
            let section = pathElements.shift()!;
            let branch = this.children.find((child) => {
                return child instanceof ExerciseTreeBranch
                    && child.pathElement === section;
            }) as ExerciseTreeBranch | undefined;
            if (branch === undefined) {
                branch = new ExerciseTreeBranch(this, section!);
                this.children.push(branch);
            }
            branch.addExercise!(pathElements, exercise);
        }
    }

    protected checkChildren() {
        // If any children aren't success, this will be overridden
        // Use a temporary value, so we don't incorrectly set this.success
        let success: boolean | undefined = true;
        this.children.find((child) => {
            if (child.success !== true) {
                success = child.success;
                return true;
            }
            return false;
        });
        this.success = success;
        // If any children aren't done, this will be overridden
        // Use a temporary value, so we don't incorrectly set this.done
        let done: boolean | undefined = true;
        this.children.find((child) => {
            if (child.done !== true) {
                done = child.done;
                return true;
            }
            return false;
        });
        this.done = done;
    }

    public update(
        eventEmitter?: vscode.EventEmitter<ExerciseTreeItem | undefined>
    ) {
        this.checkChildren();
        const oldIconPath = this.iconPath;
        const oldCheckboxState = this.checkboxState;
        this.iconPath = iconForSuccessState(this.success);
        this.checkboxState = checkboxStateForDoneState(this.done);
        if (oldIconPath !== this.iconPath
            || oldCheckboxState !== this.checkboxState) {
            eventEmitter?.fire(this);
        }
        this.parent?.update(eventEmitter);
    }

    public markDone(provider: RustlingsExercisesProvider, done: boolean) {
        this.children.forEach((child) => {
            child.markDone(provider, done);
        });
    }

}

class ExerciseTree extends ExerciseTreeBranch {
    constructor(
        private _treeView: vscode.TreeView<ExerciseTreeItem>,
        folderName: string,
        exercises: Exercise[]
    ) {
        super(undefined, undefined, folderName);
        this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        exercises.forEach((exercise) => {
            // Split into ['exercises/', '<section>/', '<exercise>']
            // or ['exercises/', '<quiz>']
            const pathElements = exercise.path.split(/(?<=\/)/);
            // Remove the first element
            const chop = pathElements.shift();
            if (chop !== 'exercises/') {
                vscode.window.showErrorMessage(
                    `Invalid exercise path: ${exercise.path} in info.toml`
                );
                return;
            }
            this.addExercise(pathElements, exercise);
        });
    }

    public update(
        eventEmitter?: vscode.EventEmitter<ExerciseTreeItem | undefined>
    ): void {
        this.checkChildren();
        if (this.done && this.success) {
            this._treeView.message = "You have finished all the exercises!";
        } else {
            this._treeView.message = undefined;
        }
    }
}

type ExerciseTreeItem = ExerciseTreeBranch | ExerciseTreeLeaf;

export class RustlingsExercisesProvider
    implements vscode.TreeDataProvider<ExerciseTreeItem>
{
    private _onDidChangeTreeData =
        new vscode.EventEmitter<ExerciseTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _view?: vscode.TreeView<ExerciseTreeItem>;

    private _rustlingsFolders: RustlingsFolder[] = [];

    private _watchTerminal: vscode.Terminal | undefined = undefined;

    private _autoDone: boolean = false;

    private readonly iAmNotDoneRegex = /^\s*\/\/\/?\s*I\s+AM\s+NOT\s+DONE\n?/m;

    constructor() {

    }

    public dispose() {
        this._onDidChangeTreeData.dispose();
    }

    setView(treeView: vscode.TreeView<ExerciseTreeItem>) {
        this._view = treeView;
        this._view.onDidChangeCheckboxState(
            (event) => {
                event.items.forEach(async (item) => {
                    let [treeItem, state] = item;
                    treeItem.markDone(this, state === vscode.TreeItemCheckboxState.Checked);
                });
            }
        );
    }

    private async _getExercises(
        folder: vscode.WorkspaceFolder
    ): Promise<Exercise[]> {
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
                    success: undefined,
                    done: undefined,
                    uri: Uri.joinPath(folder.uri, exercise.path),
                    rootFolder: folder,
                };
            })
                .filter((exercise: Exercise) => {
                    const pathElements = exercise.path.split('/');
                    if (pathElements.length < 2
                        || pathElements[0] !== 'exercises'
                        || exercise.path.endsWith('/')) {
                        vscode.window.showErrorMessage(
                            `Invalid exercise path: ${exercise.path} in `
                            + `info.toml`
                        );
                        return false;
                    }
                    return true;
                });
        } catch (error) {
            // Reading files failed, so this isn't a rustlings folder
            return [];
        }
    }

    private _exerciseByUri(uri: Uri): Exercise | undefined {
        return this._rustlingsFolders
            .map((rustlings) => rustlings.exercisesMap.get(uri.toString()))
            .find((exercise) => exercise !== undefined);
    }


    private _getNextExercise(currentExercise?: Exercise): Exercise | undefined {
        let rustlings;
        if (currentExercise === undefined) {
            const currentUri = vscode.window.activeTextEditor?.document.uri;
            if (currentUri !== undefined) {
                currentExercise = this._exerciseByUri(currentUri);
            }
        }
        if (currentExercise !== undefined) {
            rustlings = this._rustlingsFolders.find(
                (rustlings) => rustlings.folder === currentExercise!.rootFolder
            );
            let index = rustlings?.exercises.indexOf(currentExercise);
            if (index !== undefined && index >= 0) {
                index++;
                // The only way index is defined is if rustlings is defined
                // and exercises is defined, so we can safely use ! here.
                // Also wrap around if we're at the end.
                index %= rustlings!.exercises.length;
                return rustlings!.exercises[index];
            }
        }
        if (rustlings === undefined) {
            rustlings = this._rustlingsFolders[0];
        }
        const folder = rustlings.folder;
        return rustlings.exercises.find(
            (exercise) => !exercise.done || !exercise.success
        );
    }

    async updateRustlingsFolders() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders === undefined) {
            this._rustlingsFolders = [];
        } else {
            // Because filter() requires a synchronous function, we can't use
            // getExercises() directly. Instead, we use map() to create an array
            // of promises, then use Promise.all() to wait for all of them to
            // resolve.
            let foldersPromises = workspaceFolders.map(async (folder) => {
                return {
                    folder: folder,
                    exercises: await this._getExercises(folder)
                };
            });
            assert(this._view !== undefined);
            this._rustlingsFolders = (await Promise.all(foldersPromises))
                .filter((rustlings) => rustlings.exercises.length > 0)
                .map((rustlings, index) =>
                    new RustlingsFolder(
                        this._view!,
                        rustlings.folder,
                        rustlings.exercises
                    )
                );
        }
        vscode.commands.executeCommand(
            'setContext', 'rustlings-helper:hasRustlings',
            this._rustlingsFolders.length > 0
        );
        this._onDidChangeTreeData.fire(undefined);
        this._rustlingsFolders.forEach(
            (rustlings) => rustlings.checkStatus(this._onDidChangeTreeData)
        );
    }

    getChildren(
        branch?: ExerciseTreeBranch
    ): (ExerciseTreeBranch | ExerciseTreeLeaf)[] | undefined {
        if (branch === undefined) {
            return this._rustlingsFolders.map(
                (rustlings) => rustlings.exercisesTree
            );
        }
        return branch.children;
    }

    getParent(item: ExerciseTreeItem): ExerciseTreeBranch | undefined {
        return item.parent;
    }

    getTreeItem(item: ExerciseTreeItem): vscode.TreeItem {
        return item;
    }

    rustlingsWatch() {
        if (this._rustlingsFolders.length === 0) {
            return;
        }
        // TODO: support multiple folders for Watch
        const cwd = this._rustlingsFolders[0].folder.uri.fsPath;
        if (this._watchTerminal === undefined
            || this._watchTerminal.exitStatus !== undefined
        ) {
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
        vscode.commands.executeCommand(
            'setContext',
            'rustlings-helper:watching',
            watching
        );
    }

    public async openNextExercise(currentExercise?: Exercise) {
        const nextExercise = await this._getNextExercise(currentExercise);
        if (nextExercise === undefined) {
            vscode.window.showInformationMessage(
                'You finished all the exercises!'
            );
        } else {
            vscode.commands.executeCommand('vscode.open', nextExercise.uri);
        }
    }

    public async openExercise() {
        const showRoot = this._rustlingsFolders.length > 1;
        // show picker with all exercises
        class ExercisePickerItem implements vscode.QuickPickItem {
            public readonly label: string;
            public readonly description: string | undefined = undefined;
            constructor(public readonly exercise: Exercise) {
                this.label = this.exercise.path.replace(/exercises\//, '');
                if (this.exercise.done) {
                    this.label = '$(check) ' + this.label;
                }
                this.label = iconForSuccessState(this.exercise.success).id
                    + ' ' + this.label;
                if (showRoot) {
                    this.description = exercise.rootFolder.uri.toString();
                }
            }
            // TODO: show status in detail field
        }

        const pickItems = this._rustlingsFolders.flatMap(
            (folder) => folder.exercises.map(
                (exercise) => new ExercisePickerItem(exercise)
            )
        );
        const picked = await vscode.window.showQuickPick(pickItems);
        if (picked === undefined) {
            return;
        }
        const exercise = picked.exercise;
        if (exercise === undefined) {
            vscode.window.showErrorMessage(
                `Could not find '${picked}' in exercises`
            );
            return;
        }
        vscode.commands.executeCommand('vscode.open', exercise.uri);
    }

    private async _readTextFile(uri: Uri): Promise<string> {
        let document = vscode.workspace.textDocuments.find(
            (document) => document.uri.toString() === uri.toString()
        );
        if (document !== undefined) {
            return document.getText();
        }
        const fileBytes = await vscode.workspace.fs.readFile(uri);
        const buffer = Buffer.from(fileBytes);
        return buffer.toString();
    }

    private async _writeTextFile(uri: Uri, text: string): Promise<void> {
        const buffer = Buffer.from(text);
        await vscode.workspace.fs.writeFile(uri, buffer);
    }

    public async fileChanged(uri: Uri): Promise<Exercise | undefined> {
        console.log('fileChanged', uri.toString());
        const exercise = this._exerciseByUri(uri);
        if (exercise === undefined) {
            // If it's not an exercise, we don't care
            return;
        }
        exercise.success = undefined;
        exercise.done = undefined;
        exercise.treeItem?.update(this._onDidChangeTreeData);
        // Hoping that this actually doesn't block the event loop
        const text = await this._readTextFile(uri);
        exercise.done = text.match(this.iAmNotDoneRegex) === null;
        exercise.treeItem?.update(this._onDidChangeTreeData);
        // Allow the view to update before we check the file
        //        setTimeout(async () => {
        const success = await runExercise(
            exercise,
            this._onDidChangeTreeData
        );
        const activeEditor = vscode.window.activeTextEditor;
        if (!(activeEditor?.document.uri.toString() === uri.toString())) {
            // If the active editor isn't looking at the file that changed,
            // don't do anything else.
            return;
        }
        if (success) {
            if (!exercise.done && this._autoDone) {
                this.toggleDone();
            } else if (exercise.done) {
                vscode.window.showInformationMessage(
                    'You finished ' + exercise.name + '!'
                );
                await vscode.commands.executeCommand(
                    'workbench.action.closeActiveEditor'
                );
                this.openNextExercise(exercise);
            }
        }
        //        });
    }

    public async checkActiveEditor(
        editor: vscode.TextEditor | undefined,
    ) {
        const exercise = editor
            ? this._exerciseByUri(editor.document.uri)
            : undefined;
        vscode.commands.executeCommand(
            'setContext',
            'rustlings-helper:exerciseOpen',
            exercise !== undefined
        );
        if (exercise !== undefined) {
            this._view?.reveal(exercise.treeItem!, { select: true });
            runExercise(exercise, this._onDidChangeTreeData);
        }
        if (exercise?.name === 'intro1' && !exercise.done) {
            const message1 = 'Welcome to the Rustlings Helper extension! '
                + 'Please read the comments in intro1.rs before continuing, '
                + 'but do not make any changes yet. Press Next when you are '
                + 'done reading.';
            await vscode.window.showInformationMessage(
                message1,
                'Next'
            );
            const message2 = 'This extension can remove the I AM NOT DONE '
                + 'comment from the current exercise using the checkbox in the '
                + '[Exercises](command:rustlingsHelper.exercisesView.focus) '
                +  'view, or by using the [Rustlings Helper: Toggle Done]'
                + '(command:rustlings-helper.toggleDone) command.';
            vscode.window.showInformationMessage(
                message2,
                'Mark as done now'
            );
        }
    }

    private async _askToSaveForDone(
        document: vscode.TextDocument,
        done: boolean,
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

    public async markDone(exercise: Exercise, done: boolean) {
        const uri = exercise.uri;
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
                exercise.treeItem?.update(this._onDidChangeTreeData);
                return;
            }
        }
        assert(document === undefined || !document.isDirty);
        // If the document isn't open or isn't dirty, just do raw file access.
        // If there is an editor open for it, it will update automatically. If
        // there isn't, we don't want to open one, needlessly.
        let text = await this._readTextFile(exercise.uri);
        if (done) {
            text = text.replace(this.iAmNotDoneRegex, '');
        } else {
            // Determine EOL style
            // Is this overkill? Maybe.
            const windowsEol = text.match(/\r\n/)?.length ?? 0;
            const unixEol = text.match(/(?<!\r)\n/)?.length ?? 0;
            const eol = windowsEol > unixEol ? '\r\n' : '\n';
            text = '// I AM NOT DONE' + eol + text;
        }
        await this._writeTextFile(exercise.uri, text);
        exercise.done = done;
        exercise.treeItem?.update(this._onDidChangeTreeData);
    }

    public async toggleDone() {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined) {
            return;
        }
        const document = editor.document;
        const exercise = this._exerciseByUri(document.uri);
        if (exercise === undefined) {
            vscode.window.showErrorMessage(
                'This file is not part of a rustlings exercise'
            );
            return;
        }
        this.markDone(exercise, !exercise.done);
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
        vscode.commands.executeCommand('vscode.open', readmeUri);
    }

}

