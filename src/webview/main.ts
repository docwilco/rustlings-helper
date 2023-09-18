import {
    provideVSCodeDesignSystem,
    vsCodeButton,
    vsCodeDivider,
    vsCodePanels,
    vsCodePanelTab,
    vsCodePanelView,
    Button
} from "@vscode/webview-ui-toolkit";

provideVSCodeDesignSystem().register(
    vsCodeButton(),
    vsCodeDivider(),
    vsCodePanels(),
    vsCodePanelTab(),
    vsCodePanelView()
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
            if (!hint || !readme) {
                console.error("Could not find hint or readme elements");
                return;
            }
            // We only need to hide things if they have changed. Especially for
            // the Readme, since this doesn't change between exercises in the
            // same module.
            if (hint.innerHTML !== message.hintHtml) {
                hint.innerHTML = message.hintHtml;
                hideHint();
            }
            if (readme.innerHTML !== message.readmeHtml) {
                readme.innerHTML = message.readmeHtml;
                hideReadme();
            }
            break;
        default:
            console.error("Unknown message received from extension");
    }
});

function main() {
    // To get improved type annotations/IntelliSense the associated class for
    // a given toolkit component can be imported and used to type cast a reference
    // to the element (i.e. the `as Button` syntax)
    const showHintButton = document.getElementById("show-hint-button") as Button;
    showHintButton?.addEventListener("click", showHint);
    const hideHintButton = document.getElementById("hide-hint-button") as Button;
    hideHintButton?.addEventListener("click", hideHint);
    const showReadmeButton = document.getElementById("show-readme-button") as Button;
    showReadmeButton?.addEventListener("click", showReadme);
    const hideReadmeButton = document.getElementById("hide-readme-button") as Button;
    hideReadmeButton?.addEventListener("click", hideReadme);
}

function showHint() {
    const hintVisible = document.getElementById("hint-visible");
    const hintHidden = document.getElementById("hint-hidden");
    hintVisible!.hidden = false;
    hintHidden!.hidden = true;
}

function hideHint() {
    const hintVisible = document.getElementById("hint-visible");
    const hintHidden = document.getElementById("hint-hidden");
    hintVisible!.hidden = true;
    hintHidden!.hidden = false;
}

function showReadme() {
    const readmeVisible = document.getElementById("readme-visible");
    const readmeHidden = document.getElementById("readme-hidden");
    readmeVisible!.hidden = false;
    readmeHidden!.hidden = true;
}

function hideReadme() {
    const readmeVisible = document.getElementById("readme-visible");
    const readmeHidden = document.getElementById("readme-hidden");
    readmeVisible!.hidden = true;
    readmeHidden!.hidden = false;
}
