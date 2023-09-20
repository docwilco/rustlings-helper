import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as toml from 'toml';
import MarkdownIt from 'markdown-it';
import { assert } from 'console';
import {
    Exercise,
    readTextFile,
} from './exercise';
import { RustlingsFolder } from './rustlingsFolder';

function iconForSuccessState(success?: boolean): vscode.ThemeIcon | undefined {
    switch (success) {
        case true:
            return undefined;
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

export class RustlingsExercisesProvider
    implements vscode.TreeDataProvider<ExerciseTreeItem>
{
    private _onDidChangeTreeData =
        new vscode.EventEmitter<ExerciseTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    public treeView?: vscode.TreeView<ExerciseTreeItem>;

    private _rustlingsFolders: RustlingsFolder[] = [];

    private _watchTerminal: vscode.Terminal | undefined = undefined;

    private _runQueue: Exercise[] = [];

    constructor() {
    }

    public dispose() {
        this._onDidChangeTreeData.dispose();
    }

    setView(treeView: vscode.TreeView<ExerciseTreeItem>) {
        this.treeView = treeView;
        this.treeView.onDidChangeCheckboxState(
            (event) => {
                event.items.forEach(async (item) => {
                    let [treeItem, state] = item;
                    treeItem.markDone(
                        state === vscode.TreeItemCheckboxState.Checked
                    );
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
            const infoToml = await readTextFile(infoUri);
            const info = toml.parse(infoToml);
            if (info.exercises === undefined) {
                return [];
            }

            // Just to be extra thorough, check Cargo.toml exists and has
            // "rustlings" as the package.name
            const cargoUri = Uri.joinPath(folder.uri, '/Cargo.toml');
            const cargoToml = await readTextFile(cargoUri);
            const cargo = toml.parse(cargoToml);
            if (cargo.package === undefined) {
                return [];
            }
            if (cargo.package.name !== 'rustlings') {
                return [];
            }

            // Read all the README.md files
            const readmeUris = new Set<Uri>(
                info.exercises.map((exercise: any) => {
                    return Uri.joinPath(
                        folder.uri,
                        exercise.path,
                        '../README.md');
                })
            );
            let readmeMap = new Map<string, string>();
            for (let readmeUri of readmeUris) {
                try {
                    const readme = await readTextFile(readmeUri);
                    readmeMap.set(readmeUri.toString(), readme);
                } catch (error) {
                }
            }

            return info.exercises.map((exercise: any): Exercise => {
                const uri = Uri.joinPath(folder.uri, exercise.path);
                const markdown = MarkdownIt({ linkify: true });
                const hintHtml = markdown.render(exercise.hint);
                const readmeUri = Uri.joinPath(uri, '../README.md');
                const readme = readmeMap.get(readmeUri.toString()) ?? '';
                const readmeHtml = markdown.render(readme);
                return new Exercise(
                    exercise.name,
                    exercise.path,
                    exercise.mode,
                    hintHtml,
                    readmeHtml,
                    uri,
                    folder,
                );
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

    public exerciseByUri(uri: Uri): Exercise | undefined {
        return this._rustlingsFolders
            .map((rustlings) => rustlings.exercisesUriMap.get(uri.toString()))
            .find((exercise) => exercise !== undefined);
    }


    private _getNextExercise(currentExercise?: Exercise): Exercise | undefined {
        let rustlings;
        if (currentExercise === undefined) {
            const currentUri = vscode.window.activeTextEditor?.document.uri;
            if (currentUri !== undefined) {
                currentExercise = this.exerciseByUri(currentUri);
            }
        }

        if (currentExercise !== undefined) {
            rustlings = this._rustlingsFolders.find(
                (rustlings) => rustlings.folder === currentExercise!.rootFolder
            );
            let index = rustlings?.exercises.indexOf(currentExercise);
            if (index !== undefined && index >= 0) {
                // Make a new array starting at the current exercise
                let potentialNext = rustlings!.exercises.slice(index);
                potentialNext = potentialNext.concat(rustlings!.exercises.slice(0, index));
                // Take out current exercise using shift, so we don't have to
                // bounds check the index in the lines above.
                potentialNext.shift();
                return potentialNext.find(
                    (exercise) => !exercise.done || !exercise.success
                );
            }
        }
        if (rustlings === undefined) {
            rustlings = this._rustlingsFolders[0];
        }
        return rustlings?.exercises.find(
            (exercise) => !exercise.done || !exercise.success
        );
    }

    async updateRustlingsFolders() {
        vscode.commands.executeCommand(
            'setContext', 'rustlingsHelper:hasRustlingsKnown',
            false,
        );
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
            assert(this.treeView !== undefined);
            this._rustlingsFolders = (await Promise.all(foldersPromises))
                .filter((rustlings) => rustlings.exercises.length > 0)
                .map((rustlings) => new RustlingsFolder(
                    this,
                    this._onDidChangeTreeData,
                    rustlings.folder,
                    rustlings.exercises
                ));
        }
        vscode.commands.executeCommand(
            'setContext', 'rustlingsHelper:hasRustlings',
            this._rustlingsFolders.length > 0
        );
        vscode.commands.executeCommand(
            'setContext', 'rustlingsHelper:hasRustlingsKnown',
            true,
        );
        this._onDidChangeTreeData.fire(undefined);
        this._rustlingsFolders.forEach(
            (rustlings) => rustlings.queueExerciseRuns()
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
        this._rustlingsFolders.forEach((rustlings) => rustlings.watch());
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
            'rustlingsHelper:watching',
            watching
        );
    }

    public async openNextExercise(
        currentExercise?: Exercise,
        currentEditor?: vscode.TextEditor
    ) {
        const nextExercise = this._getNextExercise(currentExercise);
        if (nextExercise === undefined) {
            vscode.window.showInformationMessage(
                'You finished all the exercises!'
            );
        } else {
            // We need to open the next exercise before closing the current one,
            // because otherwise we lose the ViewColumn if it's the only editor
            // open in its column. So we need to:
            // 1. Open the next exercise, unfortunately preseveFocus doesn't
            //    preserve the tab focus, only the viewcolumn. 
            // 2. Focus and close the current exercise 
            // 3. Focus the next exercise

            // Open the next. Use openTextDocument instead of vscode.open command,
            // because we want to focus the editor after closing the current one.
            const document = await vscode.workspace.openTextDocument(
                nextExercise.uri
            );
            await vscode.window.showTextDocument(document);
            if (currentEditor === undefined) {
                return;
            }
            // Now to focus and close the current exercise
            await vscode.window.showTextDocument(currentEditor.document);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            vscode.window.showTextDocument(document);
        }
    }

    public async openExercise() {
        const showRoot = this._rustlingsFolders.length > 1;
        // show picker with all exercises
        class ExercisePickerItem implements vscode.QuickPickItem {
            public readonly label: string;
            public readonly description?: string;
            constructor(public readonly exercise: Exercise) {
                this.label = this.exercise.path.replace(/exercises\//, '');
                if (this.exercise.done) {
                    this.label = '$(check) ' + this.label;
                }
                if (this.exercise.success === false) {
                    this.label = '$(warning) ' + this.label;
                }
                if (showRoot) {
                    this.description = exercise.rootFolder.uri.toString();
                }
            }
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

    public async queueExerciseRun(exercise: Exercise, priority?: boolean): Promise<void> {
        let length;
        if (priority) {
            length = this._runQueue.unshift(exercise);
        } else {
            length = this._runQueue.push(exercise);
        }
        if (length > 1) {
            // I'm pretty sure this works
            return;
        }
        // Use setTime to give other parts a chance to add to the queue or
        // update the UI
        const runQueue = this._runQueue;
        setTimeout(async function runFirstExercise() {
            const exercise = runQueue.shift();
            if (exercise === undefined) {
                return;
            }
            await exercise.run();
            setTimeout(runFirstExercise);            
        });
    }

    public async queueExerciseRunByUri(uri: Uri): Promise<void> {
        const exercise = this.exerciseByUri(uri);
        if (exercise === undefined) {
            // If it's not an exercise, we don't care
            return;
        }
        this.queueExerciseRun(exercise);
    }

    public async checkActiveEditor(
        editor: vscode.TextEditor | undefined
    ) {
        const exercise = editor
            ? this.exerciseByUri(editor.document.uri)
            : undefined;
        vscode.commands.executeCommand(
            'setContext',
            'rustlingsHelper:exerciseOpen',
            exercise !== undefined
        );
        if (exercise === undefined) {
            return;
        }
        this.treeView?.reveal(exercise.treeItem!, { select: true });
        exercise.run();
        await exercise.printRunOutput();

        if (exercise.name === 'intro1' && !exercise.done) {
            const message1 = 'Welcome to the Rustlings Helper extension! '
                + 'Please read the comments in intro1.rs before continuing, '
                + 'but do not make any changes yet. Press Next when you are '
                + 'done reading.';
            await vscode.window.showInformationMessage(
                message1,
                'Next'
            );
            const message2 = 'This extension can remove the "I AM NOT DONE" '
                + 'comment from the current exercise using the checkbox in the '
                + '[Exercises](command:rustlingsHelper.exercisesView.focus) '
                + 'view, or by using the [Rustlings Helper: Toggle Done]'
                + '(command:rustlingsHelper.toggleDone) command.';
            const button2 = await vscode.window.showInformationMessage(
                message2,
                'Mark as done now',
                'Dismiss'
            );
            if (button2 === 'Mark as done now') {
                exercise.markDone(true);
            }
        }
    }

    public async toggleDone() {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined) {
            return;
        }
        const document = editor.document;
        const exercise = this.exerciseByUri(document.uri);
        if (exercise === undefined) {
            vscode.window.showErrorMessage(
                'This file is not part of a rustlings exercise'
            );
            return;
        }
        exercise.markDone(!exercise.done);
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

export class ExerciseTreeLeaf extends vscode.TreeItem {
    success?: boolean;
    done?: boolean;
    constructor(
        private _onDidChangeTreeData:
            vscode.EventEmitter<ExerciseTreeItem | undefined>,
        public readonly parent: ExerciseTreeBranch,
        public readonly pathElement: string,
        public readonly exercise: Exercise
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

    public update() {
        const oldIconPath = this.iconPath;
        const oldCheckboxState = this.checkboxState;
        this.iconPath = iconForSuccessState(this.exercise.success);
        this.checkboxState = checkboxStateForDoneState(this.exercise.done);
        this.success = this.exercise.success;
        this.done = this.exercise.done;
        if (oldIconPath !== this.iconPath
            || oldCheckboxState !== this.checkboxState) {
            this._onDidChangeTreeData.fire(this);
        }
        this.parent.update();
    }

    public markDone(done: boolean) {
        if (done === this.done) {
            // This can happen if the user clicks on the folder's checkbox and
            // and the exercise was already in the new state.
            return;
        }
        this.exercise.markDone(done);
    }
}

class ExerciseTreeBranch extends vscode.TreeItem {
    children: (ExerciseTreeBranch | ExerciseTreeLeaf)[] = [];
    success?: boolean;
    done?: boolean;
    constructor(
        private _onDidChangeTreeData:
            vscode.EventEmitter<ExerciseTreeItem | undefined>,
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
                new ExerciseTreeLeaf(
                    this._onDidChangeTreeData,
                    this,
                    pathElements[0]!,
                    exercise
                )
            );
        } else {
            let section = pathElements.shift()!;
            let branch = this.children.find((child) => {
                return child instanceof ExerciseTreeBranch
                    && child.pathElement === section;
            }) as ExerciseTreeBranch | undefined;
            if (branch === undefined) {
                branch = new ExerciseTreeBranch(
                    this._onDidChangeTreeData,
                    this,
                    section!);
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

    public update() {
        this.checkChildren();
        const oldIconPath = this.iconPath;
        const oldCheckboxState = this.checkboxState;
        this.iconPath = iconForSuccessState(this.success);
        this.checkboxState = checkboxStateForDoneState(this.done);
        if (oldIconPath !== this.iconPath
            || oldCheckboxState !== this.checkboxState) {
            this._onDidChangeTreeData.fire(this);
        }
        this.parent?.update();
    }

    public markDone(done: boolean) {
        this.children.forEach((child) => {
            child.markDone(done);
        });
    }

}
export class ExerciseTree extends ExerciseTreeBranch {
    constructor(
        private _provider: RustlingsExercisesProvider,
        _onDidChangeTreeData: vscode.EventEmitter<ExerciseTreeItem | undefined>,
        folderName: string,
        exercises: Exercise[]
    ) {
        super(_onDidChangeTreeData, undefined, undefined, folderName);
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

    public override update(): void {
        this.checkChildren();
        if (this.done && this.success) {
            this._provider.treeView!.message = "You have finished all the exercises!";
        } else {
            this._provider.treeView!.message = undefined;
        }
    }
}

export type ExerciseTreeItem = ExerciseTreeBranch | ExerciseTreeLeaf;

