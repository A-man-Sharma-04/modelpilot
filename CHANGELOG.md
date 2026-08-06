# Changelog

## 1.1.0

### Added
- **Inline Code Completions**: Real-time ghost-text code suggestions as you type in code editors using low-latency model routing (Groq, Cerebras). Includes debouncing, cancellation, and language filtering (`modelpilot.inlineCompletions`).
- **Code Search Panel & Indexer**: Workspace code search webview panel with file filters and regex search capabilities.
- **Context Compression Engine**: Strips comments and whitespace from codebase context files to minimize token consumption (`modelpilot.compressContext`).

### Security & Hardening
- **Parameterized Execution**: Hardened Git and MCP command execution against shell injection vulnerabilities.
- **Webview XSS Protection**: HTML escaping and attribute sanitization across Analytics, Arena, and Search webview panels.
- **Scrubbed Debug Logging**: Route logs to VS Code's per-extension log directory with automatic secret scrubbing for API keys and Bearer tokens.

## 1.0.0

### Added
- **Custom Instructions Support**: Personalize ModelPilot's chat and inline code generation using a new `modelpilot.customInstructions` VS Code setting or workspace-level instructions files (`.github/copilot-instructions.md`, `.github/modelpilot-instructions.md`, `.modelpilot-instructions.md`).
- **Real-Time Compilation Diagnostics**: Automatically capture typescript/lint errors from VS Code's problems tab after file writes, allowing the model's self-correction loop to fix type errors instantly.
- **Git Commit Message suggestion on Save**: Automatically generate commit suggestions and change summaries when modified files are saved, with options to commit immediately or copy to the Git input box.
- **Offline Fallbacks for Providers**: Gracefully fallback to static/offline model profiles on model listing validation/authentication failures, preventing model registration synchronizer crashes (specifically resolving Cerebras routing issues).
- **Better Router Retry & Fallback Logic**: Prioritize Tier 1 providers and retry them round-robin before failing over to Tier 2. Robustly parse API key cooldown/reset states from headers and text response bodies.
- **Improved API Response Verification**: Propagate raw status codes and body error details to the chat panel instead of masking provider errors under generic "Empty response received from model" messages.

## 0.8.5

### Added
- **Git Commit Message Generator (`/commit`)**: Automatically analyze all tracked repository changes via `git diff` and generate a concise Conventional Commit message, then automatically commit the changes.

## 0.8.4

### Added
- **Smart Follow-up Suggestions**: Suggest 3 context-aware, highly concise follow-up questions at the end of every chat response to guide next steps.

## 0.8.3

### Added
- **Terminal Command Suggestions (`/terminal`)**: Generate shell-appropriate command suggestions with an interactive `[▶ Run in Terminal]` button that executes them instantly in a dedicated `ModelPilot` VS Code terminal.

## 0.8.2

### Added
- **ModelPilot Inline Chat**: Ask ModelPilot to edit or generate code directly in the active editor using `Ctrl+Alt+I` / `Cmd+Alt+I`, bypassing the sidebar chat entirely.
- **Automatic Codebase Context Retrieval**: Automatically analyzes user prompts for keywords, searches the workspace for matching file names, and attaches them as context to the prompt.

## 0.8.0

### Added
- **Terminal Diagnostic Copilot**: Automatically monitors terminal command failures and offers quick actions to "Explain with ModelPilot" or "Fix with ModelPilot", capturing and cleaning shell integration outputs.
- **In-Text File Reference Resolution**: Mimics Copilot's `#file` and backtick syntax, automatically parsing and attaching files mentioned in the prompt text as context.
- **New Frontier Models**: Added profiles and optimized routing weights for OpenAI's `GPT-OSS 120B` and Zhipu AI's `GLM 4.7` across Groq and Cerebras.
- **Full Tool Execution History**: Preserves all previous turns' tool calls and results in the chat history, giving the model perfect memory of created files and directory structures.
- **Enhanced Safety & Scoping Rules**: Added operational guidelines to automatically scope system-wide actions to user-accessible directories and handle security blocks gracefully.

## 0.7.0

### Added
- **Native VS Code Language Model Provider**: Registers ModelPilot as a native `vscode.LanguageModelChatProvider`, allowing users to select ModelPilot's routed models directly in VS Code's native model picker (dropdown next to the chat input). Set the model family to `'modelpilot'` and enabled `toolCalling: true` capability definitions for seamless compatibility.
- **Google AI Studio Direct Provider**: Integrates Gemini 2.5 Pro (1M context) and Gemini 2.5 Flash as direct providers, running completions directly with the user's Google API key.
- **Proactive Tool Use in Ask Mode**: Enabled tool usage for non-chitchat queries under `/ask` mode, allowing the model to inspect the system and workspace to answer questions.
- **Quick Chat Access**: Added a status bar button `(💬 ModelPilot)` and a default keyboard shortcut (`Ctrl+Alt+M` / `Cmd+Alt+M`) to start a new ModelPilot chat session instantly.
- **Startup Tool Detection**: Automatically detects available system tools at startup and injects them into the `[WORKSPACE CONTEXT]` block.
- **Enhanced Usage Stats & Telemetry**: Measures average request latency per model and tracks fallback events in real-time. Displays the currently active masked API key (e.g. `Key 1 (sk-...3a9f)`) under each provider's safety meter on the Token & Cost Analytics dashboard.
- **Fine-Tuning JSONL Export**: Added a button on the analytics dashboard to export successful chat turns in the standard OpenAI JSONL format for model fine-tuning.
- **Real Free Models**: Cleaned up mock/simulated models and added real, free, high-performance models (DeepSeek R1 and Qwen 2.5 Coder 32B) across NVIDIA NIM, Groq, and OpenRouter.

### Changed
- **Direct Workspace Modification**: Optimized agent behavior to directly write, modify, and create workspace files using tools rather than outputting raw code blocks in the chat response. Added automatic interception of code blocks.
- **Optimized Activation Time**: Deferred and batched system tool detection to reduce extension startup activation latency back to the 10-20ms range.

## 0.6.0

### Added
- **Cerebras Provider Integration**: Support for the Cerebras Llama-3.1 inference engine for sub-second, ultra-low-latency completions.
- **Cooldown-Aware Retries**: Automatically reorder and bypass providers in rate limit cooldown, waiting for the shortest cooldown if all keys are temporarily blocked.

## 0.5.3

### Added
- **Token & Cost Analytics Dashboard**: A glassmorphic webview dashboard showing real-time token tracking, net cost savings relative to paid/commercial APIs, and a visual "Safety Meter" representing healthy vs rate-limited API key states with real-time cooldown countdowns.

## 0.5.2

### Added
- **New Model Profiles & Expert Scoring**: Added new model profiles and adjusted capability weights across expert profiles for more reliable routing.
- **Reliability Instructions**: Embedded model reliability guidelines into the system prompts.

## 0.5.1

### Added
- **Wait-Time Aware Routing & Key-String Mapping**: Dynamically reorder and bypass providers in rate limit cooldown, preferring available alternative providers instantly. Tracks key cooldown state mapped directly to API key strings. Parses precise wait times from headers (retry-after, reset) and error message texts.

## 0.5.0

### Added
- **Auto-Feedback Compiler Loop (Self-Correction)**: When a terminal command fails (non-zero exit code), the agent automatically analyzes the error output, fixes the code, and re-runs the command — looping until it succeeds or the retry limit is reached. Configurable via `modelpilot.maxAutoFixRetries` (default: 3, set to 0 to disable).

## 0.4.0

### Added
- **API Key Rotation & Rate Limit Auto-detection**: Automatically rotate configured API keys for a provider upon encountering a `429` (Rate Limit) error. The rotated key will be tried immediately for the current request, and subsequent requests will continue to use the last working key.

## 0.3.0

### Added
- **Conversation Export**: Added a new `@modelpilot /export` chat subcommand to easily export the active conversation history into a clean, formatted Markdown file (`modelpilot-chat-export-[timestamp].md`) inside the workspace root.

## 0.2.0

### Added
- **Inline Code Actions**: Integrated right-click context menu actions in the editor for Explain Code, Fix Code, Review Code, and Generate Tests. Includes dynamic checks to filter out non-code file types (markdown, json, plaintext, etc.).

### Changed
- **Workspace Tool Prioritization**: Configured the agent loop to prefer directly writing and creating files in the workspace (using `create_file` / `write_file`) rather than only showing code blocks in the chat response.

## 0.1.0

### Added
- Dynamic model routing (Groq, NVIDIA NIM, OpenRouter) with automatic fallback on provider failure.
- Workspace-aware agent tools (directory inspection, workspace search, file read/write/create/delete, terminal command execution).
- Dynamic environment/workspace context injection (detects OS, shell, active document, programming language, and project stack).
- 11 expert profiles (Coding, Security, Reverse Engineering, Binary Exploitation, Web Security, Malware Analysis, Cryptography, Linux, Writing, Documentation, Learning).
- Task decomposition routing to split complex developer requests into sequenced subtasks.
- Smart token budget estimation and semantic context trimming to fit restrictive provider context windows.
- Safety-first approval workflows (prompts on file edits or terminal commands) and out-of-workspace warning guards.
- Secure API key storage using VS Code's system-level secure keychain (`SecretStorage`).