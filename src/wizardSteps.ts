import { Exercise } from "./exercise";
import * as vscode from 'vscode';

let shownIntro1 = false;
let shownIntro2 = false;

export async function showWizardForExercise(exercise: Exercise) {
    if (exercise.name === 'intro1'
        && !shownIntro1
        // can be undefined, so use `=== false` instead of `!exercise.done`
        && exercise.done === false
    ) {
        shownIntro1 = true;
        const message1 = 'Welcome to the Rustlings Helper extension! '
            + 'Please read the comments in intro1.rs before continuing, '
            + 'but do not make any changes yet. Press Next when you are '
            + 'done reading.';
        const button1 = await vscode.window.showInformationMessage(
            message1,
            'Next',
            'Dismiss'
        );
        if (button1 === 'Dismiss') {
            return;
        }
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

    if (exercise.name === 'intro2'
        && !shownIntro2
        // Again, these can be undefined, so use `=== false` instead of `!`
        && exercise.done === false
        && exercise.success === false
    ) {
        shownIntro2 = true;
        const message1 = 'You can always see the output for the current '
            + 'exercise in the Rustlings Watch terminal. This terminal '
            + 'is automatically created when you open a Rustlings folder. '
            + 'If you can\'t see the terminal, you can open it with the '
            + '[Rustlings Helper: Open Watch Terminal]'
            + '(command:rustlingsHelper.watch) command.';
        const button1 = await vscode.window.showInformationMessage(
            message1,
            'Open Watch Terminal now',
            'Next',
            'Dismiss'
        );

        if (button1 === 'Open Watch Terminal now') {
            vscode.commands.executeCommand('rustlingsHelper.watch');
        } else if (button1 === 'Dismiss') {
            return;
        }
        const message2 = 'You can run the current exercise in the Watch '
            + 'terminal simply by saving the file. Try removing the } on the '
            + 'last line of intro2.rs and saving the file. The compiler '
            + 'message should change.';
        const button2 = await vscode.window.showInformationMessage(
            message2,
            'Next',
            'Dismiss'
        );
        if (button2 === 'Dismiss') {
            return;
        }

        const message3 = 'If you get stuck on an exercise, you can use the '
            + '[Rustlings Helper: Show Hint](command:rustlingsHelper.showHint) '
            + 'command to show a hint for the current exercise. This command '
            + 'is also available in the [Exercises]'
            + '(command:rustlingsHelper.exercisesView.focus) view with the '
            + '(?) button. Don\'t worry about closing the hint, it '
            + 'will automatically hide when you open a different exercise.';
        const button3 = await vscode.window.showInformationMessage(
            message3,
            'Show hint now',
            'Next',
            'Dismiss'
        );
        if (button3 === 'Show hint now') {
            vscode.commands.executeCommand('rustlingsHelper.showHint');
        } else if (button3 === 'Dismiss') {
            return;
        }
        const message4 = 'Instead of the hint, you can also open the README '
            + 'for the current section using the [Rustlings Helper: Show README]'
            + '(command:rustlingsHelper.showReadme) command. This command '
            + 'is also available in the [Exercises]'
            + '(command:rustlingsHelper.exercisesView.focus) view with the (i) button.';
        const button4 = await vscode.window.showInformationMessage(
            message4,
            'Show README now',
            'Dismiss'
        );
        if (button4 === 'Show README now') {
            vscode.commands.executeCommand('rustlingsHelper.showReadme');
        }
    }
}

