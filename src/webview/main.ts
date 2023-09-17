import {
    provideVSCodeDesignSystem,
    vsCodeButton,
    Button
} from "@vscode/webview-ui-toolkit";

provideVSCodeDesignSystem().register(
    vsCodeButton(),
);

const vscode = acquireVsCodeApi();

window.addEventListener("load", main);

let hintHtml = 'loading...';

// Setup listener for messages from the extension
window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.command) {
        case 'showInfo':
            const hint = document.getElementById("hint");
            const readme = document.getElementById("readme");
            hint!.innerHTML = message.hintHtml;
            readme!.innerHTML = message.readmeHtml;

            break;
        default:
            console.error("Unknown message received from extension");
    }
});

function main() {
    // To get improved type annotations/IntelliSense the associated class for
    // a given toolkit component can be imported and used to type cast a reference
    // to the element (i.e. the `as Button` syntax)
    const howdyButton = document.getElementById("howdy") as Button;
    howdyButton?.addEventListener("click", handleHowdyClick);
}

function handleHowdyClick() {
    vscode.postMessage({
        command: "hello",
        text: "Hey there partner! 🤠",
    });
}

