// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as toml from 'toml';

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

	// call checkExercise() when the user saves a file
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(checkExercise));

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
					console.log('Watch');
					break;
				case 'hint':
					console.log('Hint');
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
					<button id="watch-button">Watch</button>
					<button id="hint-button">Show Hint</button>
					Hello World
				</div>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
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

function checkExercise(document: vscode.TextDocument) {
	console.log('Document saved:', document.uri);
	const rustlings = rustlingsFolders.find((rustlings) => {
		let folder = rustlings.folder;
		// Instead of checking whether everything is the same, construct a URI
		// with the same path as the document, using the folder's URI. Then
		// compare the two URIs in string form. This is necessary because there
		// are private fields that might differ because they're caches.
		const pathIntoFolderUri = folder.uri.with({ path: document.uri.path });
		return document.uri.path.startsWith(folder.uri.path) && (pathIntoFolderUri.toString() === document.uri.toString());
	});
	if (rustlings === undefined) {
		console.log('Not a rustlings folder');
		return;
	}
	console.log('Rustlings folder:', rustlings.folder.uri.path);
	const exercise = rustlings.exercises.find((exercise) => {
		return document.uri.path.endsWith(exercise.path);
	});
	if (exercise === undefined) {
		console.log('Not a rustlings exercise');
		return;
	}
	console.log('Rustlings exercise:', exercise.name);
	
}
