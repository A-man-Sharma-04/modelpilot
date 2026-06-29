# ModelPilot

<p align="center">
  <img src="./images/icon.png" width="128" height="128" alt="ModelPilot Logo"/>
</p>

<p align="center">
  <b>Multi-Provider AI Routing & Autonomous Workspace Agents for GitHub Copilot Chat</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-%3E%3D%201.90.0-blue.svg?style=flat-square&logo=visual-studio-code" alt="VS Code Version"/>
  <img src="https://img.shields.io/badge/copilot--chat-dependency-violet?style=flat-square&logo=github" alt="Copilot Chat Dependency"/>
  <img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="License"/>
</p>

---

ModelPilot is a workspace-aware AI assistant integrated directly into VS Code as a native GitHub Copilot Chat Participant. It dynamically routes developer queries to the most suitable LLM across multiple providers (NVIDIA NIM, Groq, OpenRouter, Cerebras, and Google AI Studio) and executes tasks using an autonomous local agent loop.

<p align="center">
  <img src="./images/modelpilot_demo.gif" width="600" alt="ModelPilot Walkthrough"/>
</p>

## Core Capabilities

*   **Dynamic Model Routing**: Automatically evaluates and routes each query to the best-suited model based on the task type (e.g., coding, reasoning, security, or speed).
*   **Autonomous Agent Loop**: Solves complex engineering tasks by chain-calling local workspace tools (file read/write, directory search, and terminal execution) in a stateful loop.
*   **Native Integration**: Accessible anywhere via the `@modelpilot` chat participant handle or directly within VS Code's native model picker.
*   **Security & Control**: A strict human-in-the-loop approval system. Modifying files or running terminal commands always prompts for explicit user confirmation.

---

## Quick Start

1.  **Configure API Keys**: Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run `ModelPilot: Add API Key`.
2.  **Start a Chat**: Open the VS Code Chat panel and type `@modelpilot` followed by your request.
3.  **Use Expert Personas**: Target specific tasks using subcommands:
    *   `@modelpilot /coding` - Code generation, refactoring, and debugging.
    *   `@modelpilot /reverse-engineering` - Assembly, decompilation, and binary analysis.
    *   `@modelpilot /linux` - Shell scripting and system administration.
    *   `@modelpilot /learning` - Concept breakdowns and tutorials.

---

## Supported Providers & Models

ModelPilot rotates keys automatically on rate limits and tracks active credentials in real-time.

| Provider | Supported Models | Best For |
| :--- | :--- | :--- |
| **NVIDIA NIM** | DeepSeek R1, Qwen 2.5 Coder 32B, Llama 3.1 405B, Llama 3.3 70B, Phi 4 | Advanced coding, complex reasoning, and security analysis |
| **Groq** | Llama 3.3 70B, DeepSeek R1 Distill Llama 70B, Gemma 2 9B, Mixtral 8x7B | Ultra-low latency chat and rapid iterations |
| **Cerebras** | Llama 3.3 70B, Llama 3.1 8B | Sub-second, ultra-fast general inference |
| **OpenRouter** | DeepSeek R1 (free), Qwen 2.5 Coder 32B (free), Llama 3.3 70B (free) | High-quality free tier models |
| **Google AI Studio** | Gemini 2.5 Pro, Gemini 2.5 Flash | Large-context window tasks (up to 1M tokens) |

---

## Workspace Agent Tools

When running in Agent mode, ModelPilot utilizes local tools to interact with your workspace:
*   **File Operations**: Safely read, write, create, or delete files (`read_file`, `write_file`, `create_file`, `delete_file`).
*   **Code Search**: Search files and directory structures (`search_workspace`, `list_directory`).
*   **Command Execution**: Run build scripts, linters, or test suites (`run_terminal_command`).

---

## Privacy & Security

*   **Zero Telemetry**: ModelPilot does not collect, log, or transmit any telemetry or usage metrics.
*   **Secure Storage**: All API keys are stored locally using VS Code's native, system-level `SecretStorage` keychain.
*   **Out-of-Workspace Guards**: Prominently warns you if any terminal command attempts to traverse or access directories outside the active workspace.
*   **Direct Communication**: Request payloads are sent directly from your machine to the configured AI provider endpoints. No middleman servers are used.

For more details, see [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).
