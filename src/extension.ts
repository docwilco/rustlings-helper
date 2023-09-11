// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as toml from 'toml';
import * as child_process from 'child_process';

type Exercise = {
	name: string,
	path: string,
	mode: string,
	hint: string
};

let rustlingsFolders: { folder: vscode.WorkspaceFolder, exercises: Exercise[] }[] = [];

async function getExercises(folder: vscode.WorkspaceFolder): Promise<Exercise[]> {
	try {
		// Check if info.toml exists and contains exercises
		const infoUri = Uri.joinPath(folder.uri, '/info.toml');
		const infoToml = await vscode.workspace.fs.readFile(infoUri);
		const info = toml.parse(infoToml.toString());
		if (info.exercises === undefined) {
			return [];
		}

		// Just to be extra thorough, check Cargo.toml exists and has
		// "rustlings" as the package.name
		const cargoUri = Uri.joinPath(folder.uri, '/Cargo.toml');
		const cargoToml = await vscode.workspace.fs.readFile(cargoUri);
		const cargo = toml.parse(cargoToml.toString());
		if (cargo.package === undefined) {
			return [];
		}
		if (cargo.package.name !== 'rustlings') {
			return [];
		}
		return info.exercises.map((exercise: any) => {
			return {
				name: exercise.name,
				path: exercise.path,
				mode: exercise.mode,
				hint: exercise.hint
			};
		});
	} catch (error) {
		// Reading files failed, so this isn't a rustlings folder
		return [];
	}
}

async function updateRustlingsFolders() {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders === undefined) {
		rustlingsFolders = [];
	} else {
		// Because filter() requires a synchronous function, we can't use
		// getExercises() directly. Instead, we use map() to create an array of
		// promises, then use Promise.all() to wait for all of them to resolve.
		let foldersPromises = workspaceFolders.map(async (folder) => {
			return { folder: folder, exercises: await getExercises(folder) };
		});
		rustlingsFolders = (await Promise.all(foldersPromises))
			.filter((folder) => folder.exercises.length > 0);
	}
	console.log('Rustlings folders:', rustlingsFolders.length);
	vscode.commands.executeCommand('setContext', 'rustlings-helper:hasRustlings', rustlingsFolders.length > 0);
}

export async function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "rustlings-helper" is now active!');

	await updateRustlingsFolders();

	const provider = new RustlingsHelperViewProvider(context.extensionUri);

	context.subscriptions.push(vscode.window.registerWebviewViewProvider(RustlingsHelperViewProvider.viewType, provider));
	console.log('Registered view provider');

	// call updateRustlingsFolders() when the workspace folders change
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(updateRustlingsFolders));

	// check active editor when it changes
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(provider.checkActiveEditor));

	// Since editors can be active before the extension is activated, check the
	// active editor now.
	provider.checkActiveEditor(vscode.window.activeTextEditor);

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('rustlings-helper.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from Rustlings Helper!');
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() { }

class RustlingsHelperViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'rustlingsHelper.view';

	private _view?: vscode.WebviewView;

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this._view = webviewView;
		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,
			// Only allow the webview to access resources in our extension's view directory
			localResourceRoots: [
				vscode.Uri.joinPath(this._extensionUri, 'view'),
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (data) => {
			switch (data.type) {
				case 'watch':
					rustlingsWatch();
					break;
				case 'hint':
					console.log('Hint');
					break;
				case 'done':
					this.done();
					break;
			}
		});
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'view', 'main.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'view', 'main.css'));

		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<!--
					Use a content security policy to only allow loading images from https or from our extension directory,
					and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleUri}" rel="stylesheet">
				<title>Rustlings Helper</title>
			</head>
			<body>
				<div id="root">
					<div id="info">
					</div>
					Use "Watch" to 
					<button id="watch-button">Watch</button>
					<button id="hint-button">Show Hint</button>
					<button id="done-button">Done</button>
				</div>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}

	public async checkActiveEditor(editor: vscode.TextEditor | undefined) {
		const exerciseOpen = editor !== undefined && isExercise(editor.document.uri);
		vscode.commands.executeCommand('setContext', 'rustlings-helper:exerciseOpen', exerciseOpen);
	}


	public async done() {
		const editor = vscode.window.activeTextEditor;
		if (editor === undefined) {
			return;
		}
		const document = editor.document;
		if (!isExercise(document.uri)) {
			vscode.window.showErrorMessage('This file is not part of a rustlings exercise');
			return;
		}
		if (document.isDirty) {
			vscode.window.showErrorMessage('Please save your file before marking it as done');
			return;
		}
		const iAmDoneRegex = /^\s*\/\/\/?\s*I\s+AM\s+NOT\s+DONE/m;
		let text = document.getText();
		let matches = text.match(iAmDoneRegex);
		if (matches === null) {
			vscode.window.showInformationMessage('This file is already marked as done');
			return;
		}
		while (matches !== null) {
			const start = text.indexOf(matches[0]);
			const deleteRange = new vscode.Range(
				document.positionAt(start),
				document.positionAt(start + matches[0].length)
			);
			await editor.edit((editBuilder) => {
				editBuilder.delete(deleteRange);
			});
			text = document.getText();
			matches = text.match(iAmDoneRegex);
		}
		await document.save();
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function isExercise(uri: Uri): boolean {
	const rustlings = rustlingsFolders.find((rustlings) => {
		let folder = rustlings.folder;
		// Instead of checking whether everything is the same, construct a URI
		// with the same path as the document, using the folder's URI. Then
		// compare the two URIs in string form. This is necessary because there
		// are private fields that might differ because they're caches.
		const pathIntoFolderUri = folder.uri.with({ path: uri.path });
		return uri.path.startsWith(folder.uri.path) && (pathIntoFolderUri.toString() === uri.toString());
	});
	if (rustlings === undefined) {
		console.log('Not a rustlings folder');
		return false;
	}
	const exercise = rustlings.exercises.find((exercise) => {
		const exerciseUri = Uri.joinPath(rustlings.folder.uri, exercise.path);
		// We already know that everything else matches, so just check the path.
		return uri.path === exerciseUri.path;
	});
	if (exercise === undefined) {
		return false;
	}
	return true;	
}

let watchTerminal: vscode.Terminal | undefined = undefined;

function rustlingsWatch() {
	if (watchTerminal === undefined || watchTerminal.exitStatus !== undefined) {
		if (watchTerminal?.exitStatus) {
			watchTerminal.dispose();
		}
		watchTerminal = vscode.window.createTerminal('Rustlings Watch', 'rustlings', ['watch']);
	}
	watchTerminal.show();
}
