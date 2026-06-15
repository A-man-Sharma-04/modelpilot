# Privacy Policy for ModelPilot

ModelPilot is designed with a strict privacy-first architecture. Your code, API keys, and workspace queries remain entirely under your control.

## 1. No Telemetry or Data Collection
ModelPilot does not collect, log, or transmit any usage analytics, telemetry, crash reports, or user information. All metrics tracking and user monitoring are completely absent from the extension code.

## 2. Direct Provider Communication
ModelPilot does not operate, host, or route requests through any intermediate proxy servers. All communication happens directly from your local VS Code installation to the API endpoints of your selected providers:
*   **Groq API**: `https://api.groq.com`
*   **NVIDIA NIM API**: `https://integrate.api.nvidia.com`
*   **OpenRouter API**: `https://openrouter.ai`

## 3. Secure Credential Storage
Your API keys are stored locally on your machine using VS Code's native `SecretStorage` API. 
*   `SecretStorage` routes values directly to your operating system's secure credential store (e.g., macOS Keychain, Windows Credential Manager, or Linux `libsecret`).
*   ModelPilot never stores keys in plain text config files or workspace directories.

## 4. Workspace Context and Files
*   **Context Scope**: Only the relevant code snippets, active files list, and queries you submit are sent to the AI providers to fulfill completion requests.
*   **Local Processing**: Directory scanning, file searches, diff calculations, and workspace indexing are done entirely locally on your machine.

## 5. Third-Party Provider Privacy

When you send a request through ModelPilot, your message content is transmitted to your selected AI provider under their respective privacy policies:
- [NVIDIA Privacy Policy](https://www.nvidia.com/en-us/about-nvidia/privacy-policy/)
- [Groq Privacy Policy](https://groq.com/privacy-policy/)
- [OpenRouter Privacy Policy](https://openrouter.ai/privacy)

ModelPilot has no control over how providers handle, log, or retain submitted content. Review each provider's policy before submitting sensitive or proprietary code.
