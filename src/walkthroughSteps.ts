import { Exercise } from "./exercise";
import * as vscode from 'vscode';

type Step = {
    message: string;
    button?: string;
    buttonAction?: (exercise: Exercise) => void;
};

type ExerciseMetadata = {
    steps: Step[];
    shown: boolean;
    showForSuccess?: boolean;
};

const intro1Steps: Step[] = [
    {
        message: 'Welcome to the Rustlings Helper extension! '
            + 'Please read the comments in intro1.rs before continuing, '
            + 'but do not make any changes yet. Press Next when you are '
            + 'done reading.',
    },
    {
        message: 'This extension can remove the "I AM NOT DONE" '
            + 'comment from the current exercise using the checkbox in the '
            + '[Exercises](command:rustlingsHelper.exercisesView.focus) '
            + 'view, or by using the [Rustlings Helper: Toggle Done]'
            + '(command:rustlingsHelper.toggleDone) command.',
        button: 'Mark as done',
        buttonAction: (exercise) => exercise.markDone(true),
    },
];

const intro2Steps: Step[] = [
    {
        message: 'You can always see the output for the current '
            + 'exercise in the Rustlings Watch terminal. This terminal '
            + 'is automatically created when you open a Rustlings folder. '
            + 'If you can\'t see the terminal, you can open it with the '
            + '[Rustlings Helper: Open Watch Terminal]'
            + '(command:rustlingsHelper.watch) command.',
        button: 'Show Terminal',
        buttonAction: () =>
            vscode.commands.executeCommand('rustlingsHelper.watch'),
    },
    {
        message: 'You can run the current exercise in the Watch terminal '
            + 'simply by saving the file. Try removing the } (closing bracket)'
            + ' on the last line of intro2.rs and saving the file. The '
            + 'compiler message should change after you save the change.',
    },
    {
        message: 'If you get stuck on an exercise, you can use the '
            + '[Rustlings Helper: Show Hint](command:rustlingsHelper.showHint) '
            + 'command to show a hint for the current exercise. This command '
            + 'is also available in the [Exercises]'
            + '(command:rustlingsHelper.exercisesView.focus) view with the '
            + '(?) button. Don\'t worry about closing the hint, it '
            + 'will automatically hide when you open a different exercise.',
        button: 'Show Hint',
        buttonAction: () =>
            vscode.commands.executeCommand('rustlingsHelper.showHint'),
    },
    {
        message: 'Instead of the hint, you can also open the README '
            + 'for the current section using the [Rustlings Helper: Show README]'
            + '(command:rustlingsHelper.showReadme) command. This command '
            + 'is also available in the [Exercises]'
            + '(command:rustlingsHelper.exercisesView.focus) view with the (i) button.',
        button: 'Show README',
        buttonAction: () =>
            vscode.commands.executeCommand('rustlingsHelper.showReadme'),
    },
];

const metadata: Record<string, ExerciseMetadata> = {
    intro1: { steps: intro1Steps, shown: false, showForSuccess: true },
    intro2: { steps: intro2Steps, shown: false },
};

export async function showWalkthroughForExercise(exercise: Exercise) {
    // This can also be undefined, we only want to show the walkthrough if the
    // exercise is not done and we know for sure. We also need to know whether
    // or not we know for sure that there is a success or not.
    if (exercise.done !== false || exercise.success === undefined) {
        return;
    }

    const config = vscode.workspace.getConfiguration('rustlingsHelper');
    const showWalkthrough = config.get<boolean>('showWalkthrough');
    if (!showWalkthrough) {
        return;
    }

    const exerciseMetadata = metadata[exercise.name];
    // If there's no steps, or we've shown already, don't show.
    if (exerciseMetadata === undefined || exerciseMetadata.shown) {
        return;
    }

    // Either we want to show on success and we're not successful, or we don't
    // want to show on success and we are successful. Either way, don't show.
    // ! on both to turn undefined into effectively false.
    if (!exerciseMetadata.showForSuccess !== !exercise.success) {
        return;
    }

    const steps = exerciseMetadata.steps.map((step, index) => ({ index, step }));
    for (const { index, step } of steps) {
        const buttons = [];
        if (step.button) {
            buttons.push(step.button);
        }
        if (index < steps.length - 1) {
            buttons.push('Next');
        }
        buttons.push('Dismiss', 'Never show walkthroughs');
        const buttonPushed = await vscode.window.showInformationMessage(
            step.message,
            ...buttons
        );
        // If the user just doesn't interact and lets the information message
        // time out, we want to show the walkthrough again next time. If they
        // interact, the code reaches this point. Otherwise it awaits forever, I
        // guess?
        exerciseMetadata.shown = true;
        if (buttonPushed === 'Never show walkthroughs') {
            await config.update('showWalkthrough', true);
            return;
        }
        if (buttonPushed === 'Dismiss') {
            return;
        }
        if (buttonPushed === step.button) {
            step.buttonAction?.(exercise);
        }
    }
}

