# Security Architecture of ModelPilot

ModelPilot follows a strict, multi-layered security model to protect your local environment and source code from unauthorized modifications or execution.

## 1. Human-in-the-Loop Approval Control
ModelPilot implements a strict gatekeeper mechanism for all state-changing operations. The AI assistant can request tool operations, but the extension will block execution until you click **Approve**:
*   **Modifying Operations**: Writing files, creating files, deleting files, and executing terminal commands *always* require explicit user approval.
*   **Read-Only Operations**: Listing directory contents, reading file contents, and listing open documents are allowed to run automatically to build context, but do not modify your system.

## 2. Directory and Path Bounds Enforcement
To prevent the assistant from reading or writing system-critical files outside your project:
*   **Workspace Lock**: Standard filesystem tools (`read_file`, `write_file`, `create_file`, `delete_file`) are locked to the root directory of your active VS Code workspace.
*   **Escape Detection**: If a terminal execution command attempts to use upward-traversing relative paths (`../`), home directory paths (`~`, `$HOME`), or absolute paths pointing outside your active workspace root, ModelPilot displays a prominent **out-of-workspace boundary warning** in the user confirmation card to alert you of potential escape attempts.

## 3. Secure Key Isolation
*   **VS Code Keychain**: All API keys are isolated using VS Code's `SecretStorage` API, which leverages OS-level credential managers (macOS Keychain, Windows Credential Manager, Linux libsecret).
*   **Key Deduplication**: ModelPilot checks for duplicates and trims key inputs to prevent storage of malformed keys or accidental leaks in workspace state variables.

## 4. Secure Scripting & Command Execution
Terminal commands are queued and run sequentially. If you interrupt a stream or click the **Stop** button, the active process controller signal is aborted immediately, preventing runaway or hanging background tasks.
