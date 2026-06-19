# Changelog

## 0.9.0

### Added
- **Google AI Studio Direct Provider**: Integrates Gemini 2.5 Pro (1M context) and Gemini 2.5 Flash as direct providers, bypassing OpenRouter and running completions directly with the user's Google API key.
- **Enhanced Usage Stats**: Measures request latency (average latency per model) and tracks fallback events in real-time across providers/models.
- **Fine-Tuning JSONL Export**: Collects successful chat turns and exports them in the standard OpenAI JSONL format for fine-tuning.
- **Key Rotation Telemetry**: Displays the currently active masked API key (e.g. `Key 1 (sk-...3a9f)`) in real-time under each provider's safety meter.

## 0.8.0

### Added
- **Native VS Code Language Model Provider**: Registers ModelPilot under the VS Code chat participant framework as a native `vscode.LanguageModelChatProvider`, allowing users to select ModelPilot's routed models directly in VS Code's native model picker next to the chat input box.

## 0.7.1

### Added
- **Cerebras Support in Analytics**: Fully integrated Cerebras usage statistics, token counts, and cost-savings telemetry into the analytics dashboard.

## 0.7.0

### Changed
- **Direct Workspace Modification**: Optimized agent behaviour to directly write, modify, and create workspace files using tools rather than outputting raw code blocks in the chat response. Added automatic interception of code blocks.

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