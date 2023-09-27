import * as vscode from 'vscode';
import { ExerciseTree, ExerciseTreeItem, RustlingsExercisesProvider } from './rustlingsExercisesProvider';
import { Exercise } from './exercise';
import * as child_process from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(child_process.exec);

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
        // Check whether rust-project.json exists at the root
        const rustProjectUri = vscode.Uri.joinPath(
            this.folder.uri,
            'rust-project.json'
        );
        const rustProjectExists = await vscode.workspace.fs
            .stat(rustProjectUri)
            .then(
                () => true,
                () => false
            );
        if (rustProjectExists) {
            return;
        }
        const rustlingsLSPRan = await execAsync('rustlings lsp', {
            cwd: this.folder.uri.fsPath,
        }).then(
            (_) => true
        ).catch((err) => {
            vscode.window.showErrorMessage(err.message);
            return false;
        });
        if (!rustlingsLSPRan) {
            return;
        }
        // Restart rust-analyzer if it's installed
        const rustAnalyzerExtension = vscode.extensions.getExtension(
            'rust-lang.rust-analyzer'
        );
        if (rustAnalyzerExtension !== undefined) {
            if (rustAnalyzerExtension.isActive) {
                vscode.commands.executeCommand('rust-analyzer.restartServer');
            }
            // Hoping that rust-analyzer reads the new rust-project.json after
            // activating, and not during. Otherwise we'll have to wait for the
            // activation to complete and then restart it.
            return;
        }

        const button = await vscode.window.showInformationMessage(
            'You don\'t seem to have rust-analyzer installed. You can '
            + 'either install it now, or manually restart your LSP server '
            + 'of choice to enable LSP for Rustlings.',
            'Install rust-analyzer',
            'Dismiss'
        );
        if (button === 'Install rust-analyzer') {
            vscode.commands.executeCommand(
                'workbench.extensions.installExtension',
                'rust-lang.rust-analyzer'
            );
        }
        return;
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
