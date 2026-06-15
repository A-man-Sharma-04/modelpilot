# ModelPilot
### Workspace-Aware AI Assistant with Dynamic Model Routing

**ModelPilot** is a workspace-aware AI coding assistant that dynamically routes requests to the most suitable available model. Equipped with an **autonomous workspace agent loop**, ModelPilot can edit files, inspect directories, and run shell commands in a safe, human-in-the-loop environment.

---

## Why ModelPilot? 🎯

Most AI coding assistants force users into a single provider or subscription. ModelPilot lets you bring your own API keys, dynamically routes requests to the most suitable available models, and provides workspace-aware agent capabilities with explicit approval workflows.

---

## Features 🌟

*   **Dynamic Model Routing**: Automatically scores and selects the most suitable available model from Groq, Nvidia NIM, and OpenRouter based on your active query context.
*   **Autonomous Agent Loop**: Solves complex coding and security tasks iteratively by chaining actions (reading, writing, grep searches, and command execution).
*   **11 Expert Personas**: Pre-loaded with specialized system prompts and automatic keyword triggers for coding, cybersecurity (reverse engineering, pwn, malware analysis), systems admin, writing, and learning.
*   **Safety-First Approvals**: Absolute control over your codebase. Any action that modifies files or executes shell commands requires explicit user approval.
*   **Visual Side-by-Side Diffs**: Displays exact line-by-line diff previews of code changes before writing them to disk.
*   **Secure Secret Storage**: Credentials are securely managed using VS Code's native `SecretStorage` API (system-level keychain).

---

## Expert Profiles 🎭

ModelPilot tunes model selection using distinct weight scoring criteria for each profile:

| Icon | Expert Profile | Targeted Use Cases | Primary Capabilities |
| :---: | :--- | :--- | :--- |
| 💬 | **General** | Everyday chitchat, rapid answers | Fast/low-latency routing |
| 💻 | **Coding** | Writing code, refactoring, and debugging | `coding` (60%), `reasoning` (30%) |
| 🔬 | **Reverse Engineering** | Assembly reading, decompiling (Ghidra, IDA) | `security` (45%), `reasoning` (35%) |
| 💥 | **Binary Exploitation** | Buffer overflows, ROP chain script generation | `security` (50%), `reasoning` (35%) |
| 🌐 | **Web Security** | Web payload design (XSS, SQLi, SSRF, SSTI) | `security` (50%), `reasoning` (35%) |
| 🦠 | **Malware Analysis** | PE/ELF structural triage, YARA writing, IOCs | `security` (50%), `reasoning` (35%) |
| 🔐 | **Cryptography** | Cipher attacks, custom encoding/decoding | `reasoning` (50%), `security` (35%) |
| 🐧 | **Linux** | Shell scripting, system admin, performance | `coding` (40%), `reasoning` (35%) |
| ✍️ | **Writing** | Reports, markdown articles, creative text | `writing` (65%), `reasoning` (25%) |
| 📄 | **Documentation** | API docs, JSDocs, and README creation | `writing` (50%), `coding` (35%) |
| 📚 | **Learning** | Simplifications, tutorials, analogical breakdowns | `learning` (50%), `writing` (30%) |

---

## Workspace Features 💻

When you grant ModelPilot tool execution privileges (such as in Coding or Security profiles), the assistant utilizes local workspace tools in a closed-loop iterative cycle:

*   **Directory Inspection**: View structure (`list_directory`) and check currently open editor tabs (`get_open_files`).
*   **Workspace Search**: Fast workspace-wide code searches (`search_workspace`) to locate functions or variables.
*   **File I/O**: Safely read code files (`read_file`) and write or update source files (`write_file`, `create_file`).
*   **Integrated Terminal runs**: Execute commands (`run_terminal_command`) to run package compilation, linters, or testing frameworks.

### Zero-Workspace Fallback
If you open the chat panel without any workspace folder loaded, ModelPilot dynamically falls back to the directory of your currently active editor tab, or to your system's Home directory, allowing you to run scratchpad analysis anywhere.

---

## Feature Comparison 📊

| Feature | ModelPilot |
| :--- | :---: |
| Multiple Providers | Yes |
| Dynamic Model Routing | Yes |
| Expert Profiles | Yes |
| Workspace Agent | Yes |
| File Editing Approval Flow | Yes |
| Local Secret Storage | Yes |

---

## Screenshots 📸

| Chat Interface & Model Selection | Live Code Diff & Approval |
| :---: | :---: |
| ![ModelPilot Chat Panel](images/chat-panel.png) <br> *Dynamic model recommendation & expert selection* | ![Safety Confirmation & Diff Viewer](images/diff-viewer.png) <br> *Safety-first action cards showing line diffs* |

---

## Requirements ⚙️

*   **VS Code version**: 1.120.0 or later
*   **API Credentials**: At least one active API key from a supported provider:
    *   **Groq**
    *   **Nvidia NIM**
    *   **OpenRouter**

---

## Supported Providers 🔌

ModelPilot aggregates API endpoints from:
*   **Groq** (Low-latency LPU models)
*   **NVIDIA NIM** (Enterprise-grade models)
*   **OpenRouter** (Unified open-source & free tiers)

---

## Installation 📦

1.  Open **Visual Studio Code**.
2.  Open the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
3.  Search for **ModelPilot**.
4.  Click **Install**.

---

## Development 🛠️

To build and run ModelPilot from source:

1.  Clone the repository and install dependencies:
    ```bash
    npm install
    ```
2.  Compile the extension:
    ```bash
    npm run compile
    ```
3.  Open the repository in VS Code and press `F5` to launch the Extension Development Host.

---

## Provider Setup 🔑

ModelPilot aggregates API endpoints from major providers. To configure your keys:

1.  Open the VS Code Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
2.  Run the command: `ModelPilot: Add API Key`.
3.  Choose the provider you want to configure:
    *   **Groq**: Select for ultra-low latency LPU execution (e.g., Llama 3.3, Gemma 2, DeepSeek Distill).
    *   **Nvidia NIM**: Select for enterprise-grade frontier models (e.g., DeepSeek V4 Pro, Qwen3 Coder 480B).
    *   **OpenRouter**: Select to access hundreds of open-source models, including high-quality free tier models.
4.  Paste your API key and press Enter. The key will be stored securely.

---

## Usage 🚀

### Starting a Chat
Click the **ModelPilot Rocket** (`rocket`) icon in the Activity Bar to open the Chat sidebar view.

### Automatic Expert Activation
You do not need to manually change profiles. As you type, ModelPilot's classifier identifies keywords and dynamically switches to the target expert. For example:
*   Typing *"Check this code for a stack buffer overflow"* triggers the **Binary Exploitation** profile.
*   Typing *"Write a bash script to update packages"* triggers the **Linux** profile.

### Manual Selector
If you prefer a specific expert persona, click the active profile pill at the bottom-left of the chat pane, or use the Command Palette command: `ModelPilot: Select Expert Profile`.

---

## Security Notes 🛡️

*   **Explicit Approvals**: ModelPilot cannot modify files, delete resources, or run shell scripts silently. Any destructive or modifying command generates a confirmation card in the chat window. You must review the change or diff and click **Approve** to proceed.
*   **Out-of-Workspace Boundaries**: File tools are strictly locked to the workspace root. If a terminal command contains path arguments that point outside your workspace directory (e.g. upward-traversing relative paths like `../` or absolute system folders), ModelPilot detects the traversal and displays a prominent warning badge in the approval card.
*   **Credential Handling**: API keys are saved directly to VS Code's secure keychain database (`SecretStorage`). Keys are never saved to plain text configuration files, telemetry databases, or exposed to LLM completion payloads.

For a detailed review of our security measures, please see [Security Policy](SECURITY.md).

---

## Privacy 🔒

*   ModelPilot does not collect telemetry or usage metrics.
*   API keys are stored securely using VS Code's native `SecretStorage`.
*   Workspace content and codebase paths are only transmitted directly to the configured AI provider required to fulfill your completion requests.
*   ModelPilot does not host or route requests through any intermediary servers.

For a detailed breakdown, please see [Privacy Policy](PRIVACY.md).
