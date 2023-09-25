import * as vscode from 'vscode';
import { ExerciseTree, ExerciseTreeItem, RustlingsExercisesProvider } from './rustlingsExercisesProvider';
import { Exercise } from './exercise';

export class RustlingsFolder {
    public readonly exercisesUriMap: Map<string, Exercise>;
    public readonly exercisesTree: ExerciseTree;
    constructor(
        public readonly provider: RustlingsExercisesProvider,
        onDidChangeTreeData: vscode.EventEmitter<ExerciseTreeItem | undefined>,
        public readonly folder: vscode.WorkspaceFolder,
        public readonly exercises: Exercise[]
    ) {
        this.exercisesUriMap = new Map<string, Exercise>();
        exercises.forEach((exercise) => {
            this.exercisesUriMap.set(exercise.uri.toString(), exercise);
            exercise.rustlingsFolder = this;
        });
        this.exercisesTree = new ExerciseTree(
            this,
            onDidChangeTreeData,
            folder.name,
            exercises
        );
    }

    public async queueExerciseRuns() {
        this.exercises.forEach((exercise) => {
            this.provider.queueExerciseRun(exercise);
        });
    }

    public pty?: RustlingsPty;
    public terminal?: vscode.Terminal;

    public watch() {
        if (this.pty === undefined) {
            this.pty = new RustlingsPty(this);
        }
        if (this.terminal === undefined) {
            this.terminal = vscode.window.createTerminal({
                name: `Rustlings Watch: ${this.folder.name}`,
                pty: this.pty,
            });
        }
        this.terminal.show(true);
    }

    public async setupLSP() {
    }
}

class RustlingsPty implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    private closeEmitter = new vscode.EventEmitter<number>();
    onDidClose?: vscode.Event<number> = this.closeEmitter.event;

    private _isOpen = false;

    constructor(private _folder: RustlingsFolder) { }

    public open(): void {
        this._isOpen = true;
        this.writeEmitter.fire('Welcome to Rustlings!\r\n');
    }

    public close(): void {
        this._isOpen = false;
        this._folder.terminal?.dispose();
        this._folder.terminal = undefined;
        this._folder.pty = undefined;
        this.closeEmitter.fire(0);
    }

    public write(data: string): void {
        if (!this._isOpen) {
            return;
        }
        this.writeEmitter.fire(data);
    }

    public show() {
        this._folder.terminal?.show(true);
    }
}
