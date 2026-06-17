# Changelog

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