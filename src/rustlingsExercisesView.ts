import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as toml from 'toml';
import MarkdownIt from 'markdown-it';
import * as child_process from 'child_process';
import * as child_process_promise from 'child-process-promise';
import { assert } from 'console';

enum ExerciseStatus {
    checking,
    inProgress,
    success
}

type Exercise = {
    name: string,
    path: string,
    mode: string,
    hintHtml: string,
    status: ExerciseStatus,
    done: boolean,
    uri: Uri,
    rootFolder: vscode.WorkspaceFolder,
};

type RustlingsFolder = {
    folder: vscode.WorkspaceFolder,
    exercises: Exercise[],
    exercisesMap: Map<string, Exercise>,
    exercisesTree: ExerciseTree,
};

class ExerciseTreeLeaf extends vscode.TreeItem {
    constructor(
        public readonly pathElement: string,
        public readonly exercise: Exercise,
    ) {
        super(exercise.name);
    }
}

class ExerciseTreeBranch extends vscode.TreeItem {
    children: (ExerciseTreeBranch | ExerciseTreeLeaf)[] = [];

    constructor(
        public readonly pathElement: string,
        label?: string
    ) {
        assert(pathElement.endsWith('/'));
        super(
            // strip trailing slash
            label ?? pathElement.slice(0, -1),
            vscode.TreeItemCollapsibleState.Collapsed
        );
    }

    addExercise(pathElements: string[], exercise: Exercise) {
        if (pathElements.length === 0) {
            return;
        } else if (pathElements.length === 1) {
            this.children.push(new ExerciseTreeLeaf(pathElements[0], exercise));
        } else {
            let section = pathElements.shift()!;
            let branch = this.children.find((child) => {
                return child instanceof ExerciseTreeBranch && child.pathElement === section;
            }) as ExerciseTreeBranch | undefined;
            if (branch === undefined) {
                branch = new ExerciseTreeBranch(section!);
                this.children.push(branch);
            }
            branch.addExercise!(pathElements, exercise);
        }
    }
}

class ExerciseTree extends ExerciseTreeBranch {
    constructor(
        rustlingsFolderIndex: number,
        folderName: string,
        exercises: Exercise[]
    ) {
        super(rustlingsFolderIndex.toString() + '/', folderName);
        exercises.forEach((exercise) => {
            // Split into ['exercises/', '<section>/', '<exercise>']
            // or ['exercises/', '<quiz>']
            const pathElements = exercise.path.split(/(?<=\/)/);
            // Remove the first element
            const chop = pathElements.shift();
            if (chop !== 'exercises/') {
                vscode.window.showErrorMessage(`Invalid exercise path: ${exercise.path} in info.toml`);
                return;
            }
            this.addExercise(pathElements, exercise);
        });
    }
}

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
                    done: true,
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

    private _exerciseByUri(uri: Uri): Exercise | undefined {
        return this._rustlingsFolders
            .map((rustlings) => rustlings.exercisesMap.get(uri.toString()))
            .find((exercise) => exercise !== undefined);
    }


    public getNextExercise(currentExercise?: Exercise): Exercise | undefined {
        let rustlings;
        if (currentExercise === undefined) {
            const currentUri = vscode.window.activeTextEditor?.document.uri;
            if (currentUri !== undefined) {
                currentExercise = this._exerciseByUri(currentUri);
            }
        }
        if (currentExercise !== undefined) {
            rustlings = this._rustlingsFolders.find((folder) => folder.folder === currentExercise!.rootFolder);
        }
        if (rustlings === undefined) {
            rustlings = this._rustlingsFolders[0];
        }
        const folder = rustlings.folder;
        return rustlings.exercises.find(
            (exercise) => !exercise.done || !(exercise.status === ExerciseStatus.success)
        );
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
                .map((folder, index): RustlingsFolder => {
                    let exercisesMap = new Map<string, Exercise>();
                    folder.exercises.forEach((exercise) => {
                        // // Allow lookup through multiple keys
                        // // By their nature they do not overlap
                        // exercisesMap.set(exercise.name, exercise);
                        // exercisesMap.set(exercise.path, exercise);
                        exercisesMap.set(exercise.uri.toString(), exercise);
                        const partialTreePath = exercise.path.split('/').slice(1).join('/');
                        exercisesMap.set(partialTreePath, exercise);
                    });
                    const exercisesTree = new ExerciseTree(
                        index,
                        folder.folder.name,
                        folder.exercises
                    );
                    return {
                        folder: folder.folder,
                        exercises: folder.exercises,
                        exercisesMap: exercisesMap,
                        exercisesTree: exercisesTree,
                    };
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
        if (path.endsWith('/')) {
            const rustlingsFolder = this._rustlingsFolders[rustlingsFolderIndex];
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
        const partialTreePath = pathElements.join('/');
        const exercise = this._exerciseByKey(rustlingsFolderIndex, partialTreePath);
        const treeItem = new vscode.TreeItem(exercise!.name);
        treeItem.command = {
            command: 'vscode.open',
            arguments: [exercise!.uri],
            title: 'Open Exercise'
        };
        switch (exercise!.status) {
            case ExerciseStatus.checking:
                treeItem.iconPath = new vscode.ThemeIcon('loading~spin');
                break;
            case ExerciseStatus.inProgress:
                treeItem.iconPath = new vscode.ThemeIcon('warning');
                break;
            case ExerciseStatus.success:
                treeItem.iconPath = new vscode.ThemeIcon('thumbsup');
                break;
        }
        treeItem.checkboxState = exercise!.done ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        return treeItem;
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

    public async openNextExercise(currentExercise?: Exercise) {
        const nextExercise = await this.getNextExercise(currentExercise);
        if (nextExercise === undefined) {
            vscode.window.showInformationMessage('You finished all the exercises!');
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
                switch (this.exercise.status) {
                    case ExerciseStatus.checking:
                        this.label = '$(loading~spin) ' + this.label;
                        break;
                    case ExerciseStatus.inProgress:
                        this.label = '$(warning) ' + this.label;
                        break;
                    case ExerciseStatus.success:
                        this.label = '$(thumbsup) ' + this.label;
                        break;
                }
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
            vscode.window.showErrorMessage(`Could not find '${picked}' in exercises`);
            return;
        }
        vscode.commands.executeCommand('vscode.open', exercise.uri);
    }

    public async checkSavedDocument(document: vscode.TextDocument, keepOpen: boolean = false) {
        const exercise = this._exerciseByUri(document.uri);
        if (exercise === undefined) {
            // If it's not an exercise, we don't care
            return;
        }
        const activeEditor = vscode.window.activeTextEditor;
        exercise.status = ExerciseStatus.checking;
        // TODO: update status so it's visible in the tree view
        const text = document.getText();
        exercise.done = text.match(this.iAmNotDoneRegex) === null;
        // Check that it compiles
        const folder = exercise.rootFolder;
        child_process.exec('rustlings run ' + exercise.name, { cwd: folder.uri.fsPath }, (error, stdout, stderr) => {
            // console.log('stdout: ', stdout);
            // console.log('stderr: ', stderr);
            if (error) {
                exercise.status = ExerciseStatus.inProgress;
            } else {
                exercise.status = ExerciseStatus.success;
            }
            if (!exercise.done) {
                vscode.commands.executeCommand('setContext', 'rustlings-helper:allDone', false);
            }
            // TODO: send status to treeview

            // If the active editor changed while we were running, don't do
            // anything. We don't want to automatically mark as Done if the
            // user isn't looking at the file when saving. Neither do we want
            // to close and open the next exercise.
            if (vscode.window.activeTextEditor !== activeEditor) {
                return;
            }
            if (exercise.status === ExerciseStatus.success) {
                if (!exercise.done && this._autoDone) {
                    this.toggleDone();
                } else if (!keepOpen) {
                    vscode.window.showInformationMessage('You finished ' + exercise.name + '!');
                    vscode.commands.executeCommand('workbench.action.closeActiveEditor')
                        .then(() => {
                            this.openNextExercise(exercise);
                        });
                }
            }
        });
    }

    public async checkActiveEditor(
        editor: vscode.TextEditor | undefined,
        keepOpen: boolean = false
    ) {
        const exercise = editor ? this._exerciseByUri(editor.document.uri) : undefined;
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
        if (!this._exerciseByUri(document.uri)) {
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
        vscode.commands.executeCommand('vscode.open', readmeUri);
    }

}

