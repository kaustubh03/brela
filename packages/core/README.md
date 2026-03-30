# @brela-dev/core

Shared types and session I/O for the [Brela](https://github.com/kaustubh03/brela) AI attribution system.

## Install

```bash
npm install @brela-dev/core
```

## What's exported

### `AITool` enum

Every AI tool Brela can attribute code to:

```ts
import { AITool } from '@brela-dev/core';

AITool.COPILOT           // GitHub Copilot inline completions
AITool.COPILOT_AGENT     // GitHub Copilot Edits / agent mode
AITool.COPILOT_CLI       // gh copilot suggest / explain
AITool.CLAUDE_CODE       // Claude Code inline
AITool.CLAUDE_CODE_AGENT // Claude Code CLI writing files to disk
AITool.CURSOR            // Cursor inline completions
AITool.CURSOR_AGENT      // Cursor Composer / background agent
AITool.CODEIUM           // Codeium / Windsurf
AITool.CLINE             // Cline (saoudrizwan.claude-dev)
AITool.AIDER             // Aider CLI
AITool.CODEX_CLI         // OpenAI Codex CLI
AITool.CONTINUE          // Continue.dev
AITool.CHATGPT_PASTE     // Large paste with no known AI extension
AITool.GENERIC_AGENT     // Multi-file burst, tool unknown
AITool.UNKNOWN
```

### `DetectionMethod` enum

How the attribution was determined:

```ts
import { DetectionMethod } from '@brela-dev/core';

DetectionMethod.LARGE_INSERTION     // ≥3 newlines, ≥120 chars in one VS Code event
DetectionMethod.SHELL_WRAPPER       // Shell intent logged before AI CLI run
DetectionMethod.EXTERNAL_FILE_WRITE // File written directly to disk by an agent
DetectionMethod.MULTI_FILE_BURST    // 2+ files changed within 2 seconds
DetectionMethod.CO_AUTHOR_TRAILER   // Git commit has Co-Authored-By: Claude
DetectionMethod.FILE_WATCHER        // Background daemon detected a file change
DetectionMethod.MANUAL              // Manually recorded
```

### `AttributionEntry` interface

The shape of every recorded attribution:

```ts
import type { AttributionEntry } from '@brela-dev/core';

// {
//   file: string;               // relative path from project root
//   tool: AITool;
//   confidence: 'high' | 'medium' | 'low';
//   detectionMethod: DetectionMethod;
//   linesStart: number;
//   linesEnd: number;
//   charsInserted: number;
//   timestamp: string;          // ISO 8601
//   sessionId: string;
//   accepted: boolean;
// }
```

### `SidecarWriter`

Read and write session NDJSON files under `.brela/sessions/`:

```ts
import { SidecarWriter } from '@brela-dev/core';

const writer = new SidecarWriter('/path/to/project');
writer.write(entry);                          // append to today's file
writer.readToday();                           // all entries today
writer.readRange('2024-01-01', '2024-01-31'); // entries across a date range
```

## Part of Brela

This package is the data layer used by `@brela-dev/cli` and the `brela-vscode` extension. You only need it directly if you are building tooling on top of Brela's session data.
