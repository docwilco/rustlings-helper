import * as vscode from 'vscode';
import * as child_process_promise from 'child-process-promise';
import { ExerciseTree, ExerciseTreeItem } from './rustlingsExercisesProvider';
import { Exercise } from './exercise';

export class RustlingsFolder {
    public readonly exercisesMap: Map<string, Exercise>;
    public readonly exercisesTree: ExerciseTree;
    constructor(
        private _view: vscode.TreeView<ExerciseTreeItem>,
        onDidChangeTreeData: vscode.EventEmitter<ExerciseTreeItem | undefined>,
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
            onDidChangeTreeData,
            folder.name,
            exercises
        );
    }

    public async checkStatus() {
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
                    exercise.treeItem.update();
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
                    await exercise.run();
                }
                // We want to postpone to the next eventloop here now so that
                // the UI can update
                setTimeout(checkRunExercise);
            });
        }, 1000); // Again 1 second so updates happen
    }
}
