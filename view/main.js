//@ts-check

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.
(function () {
    const vscode = acquireVsCodeApi();

    const oldState = vscode.getState() || { colors: [] };

    console.log('in main.js');
    document.querySelector('#watch-button')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'watch' });
    });
    document.querySelector('#hint-button')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'hint' });
    });
    document.querySelector('#done-button')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'done'});
    });

    // Handle messages sent from the extension to the webview
    window.addEventListener('message', event => {
        const message = event.data; // The json data that the extension sent
        switch (message.type) {
            case 'info':
                {
                    break;
                }
        }
    });

}());


