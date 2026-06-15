# Security Architecture of ModelPilot

> ModelPilot never routes your data through intermediary servers. All requests go directly from your machine to your configured provider.

ModelPilot follows a strict, multi-layered security model to protect your local environment and source code from unauthorized modifications or execution.

## 1. Human-in-the-Loop Approval Control
ModelPilot implements a strict gatekeeper mechanism for all state-changing operations. The AI assistant can request tool operations, but the extension will block execution until you explicitly approve the request:
*   **Modifying Operations**: Writing files, creating files, deleting files, and executing terminal commands *always* require explicit user approval.
*   **Read-Only Operations**: Listing directory contents, reading file contents, and listing open documents are allowed to run automatically to build context, but do not modify your system.

All confirmations are presented natively via VS Code's warning dialog API (`vscode.window.showWarningMessage`) under modal constraints.

## 2. Directory and Path Bounds Enforcement
To prevent the assistant from reading or writing system-critical files outside your project:
*   **Workspace Lock**: Standard filesystem tools (`read_file`, `write_file`, `create_file`, `delete_file`) are locked to the root directory of your active VS Code workspace.
*   **Escape Detection**: If a terminal execution command attempts to use upward-traversing relative paths (`../`), home directory paths (`~`, `$HOME`), or absolute paths pointing outside your active workspace root, ModelPilot displays a prominent **[WARNING: Out of Workspace Boundary]** badge in the warning modal dialog to alert you of potential escape attempts.

## 3. Secure Key Isolation
*   **VS Code Keychain**: All API keys are isolated using VS Code's `SecretStorage` API, which leverages OS-level credential managers (macOS Keychain, Windows Credential Manager, Linux libsecret).
*   **Key Deduplication**: ModelPilot checks for duplicates and trims key inputs to prevent storage of malformed keys or accidental leaks in workspace state variables.

## 4. Secure Scripting & Command Execution
Terminal commands are executed sequentially. If you interrupt a stream or cancel the generation natively, the active abort signal fires, terminating the spawned process immediately and preventing runaway or hanging background tasks.

## 5. Responsible Disclosure

If you discover a security vulnerability in ModelPilot, please report it by opening a GitHub issue marked **[SECURITY]** or emailing the maintainer directly. Do not disclose security vulnerabilities publicly until they have been addressed.
