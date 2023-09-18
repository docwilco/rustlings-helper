import {
    provideVSCodeDesignSystem,
    vsCodeButton,
    vsCodeDivider,
    vsCodePanels,
    vsCodePanelTab,
    vsCodePanelView,
    Button
} from '@vscode/webview-ui-toolkit';

provideVSCodeDesignSystem().register(
    vsCodeButton(),
    vsCodeDivider(),
    vsCodePanels(),
    vsCodePanelTab(),
    vsCodePanelView()
);

window.addEventListener('load', main);

// Setup listener for messages from the extension
window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
        case 'setExerciseInfo':
            const hint = document.getElementById('hint');
            const readme = document.getElementById('readme');
            if (!hint || !readme) {
                console.error('Could not find hint or readme elements');
                return;
            }
            // We only need to hide things if they have changed. Especially for
            // the Readme, since this doesn't change between exercises in the
            // same module.
            // Hide before setting the innerHTML and show after, to avoid
            // flickering.
            if (hint.innerHTML !== message.hintHtml) {
                if (!message.showHint) {
                    hideHint();
                }
                hint.innerHTML = message.hintHtml;
            }
            if (readme.innerHTML !== message.readmeHtml) {
                if (!message.showReadme) {
                    hideReadme();
                }
                readme.innerHTML = message.readmeHtml;
            }
            if (message.showHint) {
                showHint();
            }
            if (message.showReadme) {
                showReadme();
            }
    break;
        default:
            console.error('Unknown message received from extension');
    }
});

function main() {
    // To get improved type annotations/IntelliSense the associated class for a
    // given toolkit component can be imported and used to type cast a reference
    // to the element (i.e. the `as Button` syntax)
    const showHintButton = document.getElementById('show-hint-button') as Button;
    showHintButton?.addEventListener('click', showHint);
    const hideHintButton = document.getElementById('hide-hint-button') as Button;
    hideHintButton?.addEventListener('click', hideHint);
    const showReadmeButton = document.getElementById('show-readme-button') as Button;
    showReadmeButton?.addEventListener('click', showReadme);
    const hideReadmeButton = document.getElementById('hide-readme-button') as Button;
    hideReadmeButton?.addEventListener('click', hideReadme);
}

function showHint() {
    const hintVisible = document.getElementById('hint-visible');
    const hintHidden = document.getElementById('hint-hidden');
    hintVisible!.hidden = false;
    hintHidden!.hidden = true;
    const panels = document.getElementsByTagName('vscode-panels')[0];
    panels!.setAttribute('activeid', 'hint-tab');
}

function hideHint() {
    const hintVisible = document.getElementById('hint-visible');
    const hintHidden = document.getElementById('hint-hidden');
    hintVisible!.hidden = true;
    hintHidden!.hidden = false;
}

function showReadme() {
    const readmeVisible = document.getElementById('readme-visible');
    const readmeHidden = document.getElementById('readme-hidden');
    readmeVisible!.hidden = false;
    readmeHidden!.hidden = true;
    const panels = document.getElementsByTagName('vscode-panels')[0];
    panels!.setAttribute('activeid', 'readme-tab');
}

function hideReadme() {
    const readmeVisible = document.getElementById('readme-visible');
    const readmeHidden = document.getElementById('readme-hidden');
    readmeVisible!.hidden = true;
    readmeHidden!.hidden = false;
}
