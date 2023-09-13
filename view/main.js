//@ts-check

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.
(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    const state = vscode.getState() || { autoDone: false };

    let currentExercise = null;

    function showHint() {
        if (currentExercise !== null) {
            const hint = document.querySelector('#exercise-hint');
            if (hint !== null) {
                hint.innerHTML = currentExercise.hint;
            }
        }
    }

    document.querySelector('#watch-button')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'watch' });
    });
    document.querySelector('#hint-button')?.addEventListener('click', showHint);
    document.querySelector('#done-button')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'done'});
    });
    document.querySelector('#readme-button')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'readme'});
    });
    let autoDoneCheckbox = document.querySelector('#autodone-checkbox');
    autoDoneCheckbox?.addEventListener('change', (event) => {
        // @ts-ignore
        state.autoDone = event.target.checked;
        vscode.postMessage({
            type: 'autoDone',
            value: state.autoDone
        });
        vscode.setState(state);
    });
    // @ts-ignore
    autoDoneCheckbox.checked = state.autoDone;
    vscode.postMessage({ type: 'autoDone', value: state.autoDone });

    // Handle messages sent from the extension to the webview
    window.addEventListener('message', event => {
        const message = event.data; // The json data that the extension sent
        switch (message.type) {
            case 'hint':
                {
                    showHint();
                    break;
                }
            case 'exercise':
                {
                    currentExercise = message.exercise;
                    const name = document.querySelector('#exercise-name');
                    if (name !== null) {
                        name.innerHTML = message.exercise.name;
                    }
                    if (message.status !== null) {
                        const status = document.querySelector('#exercise-status');
                        if (status !== null) {
                            status.innerHTML = message.status;
                        }
                    }
                    break;
                }
        }
    });
    vscode.postMessage({ type: 'infoRequest' });
}());


