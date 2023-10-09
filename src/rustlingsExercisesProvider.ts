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
import { promisify } from 'util';

const timeoutPromise = promisify(setTimeout);

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

    private _inhibitActiveEditorEvent = false;

    constructor() {
    }

    public dispose() {
        this._onDidChangeTreeData.dispose();
    }

    setView(treeView: vscode.TreeView<ExerciseTreeItem>) {
        this.treeView = treeView;
        this.treeView.onDidChangeCheckboxState(this._onDidChangeCheckboxState);
    }

    private _onDidChangeCheckboxState(
        event: vscode.TreeCheckboxChangeEvent<ExerciseTreeItem>
    ) {
        // As far as I'm aware, the first item is the item that was clicked on,
        // the rest are the items that VSCode thinks should be affected by that.
        // Only do the first one, the rest is handled by that item's update()
        let [firstTreeItem, firstCheckBoxState] = event.items[0]!;
        firstTreeItem.markDone(
            firstCheckBoxState === vscode.TreeItemCheckboxState.Checked
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

    private async _getNextExercise(currentExercise?: Exercise): Promise<Exercise | undefined> {
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
                // Make a new array starting after the current exercise,
                // containing everything except the current exercise.
                // `index + 1` is safe to use, because even if index is pointing
                // at the last element, slice will just return an empty array
                let candidates = rustlings!.exercises.slice(index + 1);
                candidates = candidates.concat(rustlings!.exercises.slice(0, index));
                let potentialNext;
                while (true) {
                    potentialNext = candidates.find(
                        (exercise) => !exercise.done || !exercise.success
                    );
                    if (potentialNext === undefined) {
                        return undefined;
                    }
                    if (potentialNext.done !== undefined && potentialNext.success !== undefined) {
                        return potentialNext;
                    }
                    await timeoutPromise(100);
                }
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
        const config = vscode.workspace.getConfiguration('rustlingsHelper');
        const autoOpen = config.get<boolean>('startup.openNextExercise');
        if (autoOpen) {
            this._checkExerciseOpen();
        }

        const startupConfig = vscode.workspace.getConfiguration('rustlingsHelper.startup');
        const autoSetupLSP = startupConfig.get<boolean>('setupLSP');
        if (autoSetupLSP) {   
            this._rustlingsFolders.forEach((rustlings) => {
                rustlings.setupLSP();
            });
        }
        const autoWatch = startupConfig.get<boolean>('showWatchTerminal');
        if (autoWatch) {
            this.rustlingsWatch();
        }
    }

    private _checkExerciseOpen() {
        const editor = vscode.window.visibleTextEditors.find((editor) =>
            this.exerciseByUri(editor.document.uri) !== undefined
        );
        if (editor === undefined) {
            this.openNextExercise();
        }
    }

    getChildren(
        branch?: ExerciseTreeBranch
    ): ExerciseTreeItem[] | undefined {
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

    async rustlingsWatch(tree?: vscode.TreeItem) {
        if (this._rustlingsFolders.length === 0) {
            return;
        }
        if (tree instanceof ExerciseTree) {
            tree.rustlings.watch();
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
        this._rustlingsFolders.forEach((rustlings) => {
            if (rustlings.terminal === terminal) {
                rustlings.exercisesTree.contextValue = 'rustlingsTreeWatching';
            } else {
                rustlings.exercisesTree.contextValue = 'rustlingsTreeNotWatching';
            }
            rustlings.exercisesTree.update();
        });
    }

    public async openNextExercise(
        currentExercise?: Exercise,
        currentEditor?: vscode.TextEditor
    ) {
        const nextExercise = await this._getNextExercise(currentExercise);
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
            this._inhibitActiveEditorEvent = true;
            await vscode.window.showTextDocument(document);
            if (currentEditor === undefined) {
                return;
            }
            // Now to focus and close the current exercise
            await vscode.window.showTextDocument(currentEditor.document);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            this._inhibitActiveEditorEvent = false;
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
            this._runQueue = this._runQueue.filter((e) => e !== exercise);
            length = this._runQueue.unshift(exercise);
        } else {
            if (!this._runQueue.includes(exercise)) {
                length = this._runQueue.push(exercise);
            } else {
                length = this._runQueue.length;
            }
        }
        exercise.done = undefined;
        exercise.success = undefined;
        exercise.treeItem?.update();
        // Doing two at a time seems reasonable
        if (length > 2) {
            // I'm pretty sure this works
            return;
        }
        setTimeout(this.handleQueue.bind(this));
    }

    public async handleQueue() {
        while (this._runQueue.length > 0) {
            const exercise = this._runQueue.shift()!;
            await exercise.run();
        }
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
        if (this._inhibitActiveEditorEvent) {
            return;
        }
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
        if (exercise.done === undefined || exercise.success === undefined) {
            this.queueExerciseRun(exercise, true);
        } else {
            exercise.printRunOutput();
        }
    }

    public async toggleDone(treeItem: vscode.TreeItem) {
        let exercise: Exercise | undefined;
        if (treeItem === undefined) {
            const editor = vscode.window.activeTextEditor;
            if (editor === undefined) {
                return;
            }
            const document = editor.document;
            exercise = this.exerciseByUri(document.uri);
            if (exercise === undefined) {
                vscode.window.showErrorMessage(
                    'This file is not part of a rustlings exercise'
                );
                return;
            }
            exercise.markDone(!exercise.done);
        } else if (treeItem instanceof ExerciseTreeLeaf) {
            exercise = treeItem.exercise;
            exercise.markDone(!exercise.done);
        } else if (treeItem instanceof ExerciseTreeBranch) {
            treeItem.markDone(!treeItem.done);
        }
    }

    public async resetExercise(treeItem?: vscode.TreeItem) {
        let exercise: Exercise | undefined;
        if (treeItem === undefined) {
            const editor = vscode.window.activeTextEditor;
            if (editor === undefined) {
                return;
            }
            exercise = this.exerciseByUri(editor.document.uri);
            if (exercise === undefined) {
                return;
            }
        } else if (treeItem instanceof ExerciseTreeLeaf) {
            exercise = treeItem.exercise;
        }
        if (exercise === undefined) {
            return;
        }
        return exercise.reset();
    }

}

export abstract class ExerciseTreeItem extends vscode.TreeItem {
    public success?: boolean;
    public done?: boolean;

    constructor(
        protected onDidChangeTreeData:
            vscode.EventEmitter<ExerciseTreeItem | undefined>,
        public readonly parent: ExerciseTreeBranch | undefined,
        label: string | vscode.TreeItemLabel,
        collapsibleState?: vscode.TreeItemCollapsibleState,
    ) {
        super(label, collapsibleState);
    }

    public abstract markDone(done: boolean): void;

    public update() {
        const oldIconPath = this.iconPath;
        const oldCheckboxState = this.checkboxState;
        this.iconPath = iconForSuccessState(this.success);
        this.checkboxState = checkboxStateForDoneState(this.done);
        if (oldIconPath !== this.iconPath
            || oldCheckboxState !== this.checkboxState) {
            this.onDidChangeTreeData.fire(this);
            this.parent?.update();
        }
    }
}

export class ExerciseTreeLeaf extends ExerciseTreeItem {
    constructor(
        emitter:
            vscode.EventEmitter<ExerciseTreeItem | undefined>,
        parent: ExerciseTreeBranch,
        public readonly pathElement: string,
        public readonly exercise: Exercise
    ) {
        super(emitter, parent, exercise.name);
        exercise.treeItem = this;
        this.success = exercise.success;
        this.done = exercise.done;
        this.command = {
            command: 'vscode.open',
            title: 'Open Exercise',
            arguments: [exercise.uri]
        };
        this.contextValue = 'exercise';
        this.update();
    }

    public override update() {
        this.success = this.exercise.success;
        this.done = this.exercise.done;
        super.update();
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

class ExerciseTreeBranch extends ExerciseTreeItem {
    children: ExerciseTreeItem[] = [];
    constructor(
        emitter:
            vscode.EventEmitter<ExerciseTreeItem | undefined>,
        parent: ExerciseTreeBranch | undefined,
        public readonly pathElement: string | undefined,
        label?: string
    ) {
        if (pathElement === undefined) {
            pathElement = '';
        }
        super(
            emitter,
            parent,
            // strip trailing slash
            label ?? pathElement?.slice(0, -1),
            vscode.TreeItemCollapsibleState.Collapsed
        );
        // this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'section';
    }

    addExercise(pathElements: string[], exercise: Exercise) {
        if (pathElements.length === 0) {
            return;
        } else if (pathElements.length === 1) {
            this.children.push(
                new ExerciseTreeLeaf(
                    this.onDidChangeTreeData,
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
                    this.onDidChangeTreeData,
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

    public override update() {
        this.checkChildren();
        super.update();
    }

    public markDone(done: boolean) {
        this.children.forEach((child) => {
            child.markDone(done);
        });
    }

}
export class ExerciseTree extends ExerciseTreeBranch {
    public loaded = false;
    constructor(
        public rustlings: RustlingsFolder,
        _onDidChangeTreeData: vscode.EventEmitter<ExerciseTreeItem | undefined>,
        folderName: string,
        exercises: Exercise[]
    ) {
        super(_onDidChangeTreeData, undefined, undefined, folderName);
        // Overwritten with rustlingsTreeWatching or rustlingsTreeNotWatching
        // so don't use this.
        this.contextValue = 'rustlings';
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
        this.loaded = true;
    }

    public override update(): void {
        if (!this.loaded) {
            return;
        }
        this.checkChildren();
        if (this.done === true && this.success === true) {
            this.rustlings.provider.treeView!.message = "You have finished all the exercises!";
            vscode.window.showInformationMessage(
                "Congratulations! You have finished all the exercises!",
                "Dismiss"
            );
        } else {
            this.rustlings.provider.treeView!.message = undefined;
        }
        this.onDidChangeTreeData.fire(this);
    }
}
