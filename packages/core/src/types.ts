export enum AITool {
  // Inline completion tools
  COPILOT       = 'COPILOT',
  CLAUDE_CODE   = 'CLAUDE_CODE',
  CURSOR        = 'CURSOR',
  CODEIUM       = 'CODEIUM',
  CHATGPT_PASTE = 'CHATGPT_PASTE',
  // Agent / multi-file tools
  COPILOT_AGENT     = 'COPILOT_AGENT',      // GitHub Copilot Edits / agent mode
  COPILOT_CLI       = 'COPILOT_CLI',        // GitHub Copilot CLI (gh copilot suggest/explain)
  CLAUDE_CODE_AGENT = 'CLAUDE_CODE_AGENT',  // Claude Code CLI writing files
  CURSOR_AGENT      = 'CURSOR_AGENT',       // Cursor Composer / background agent
  CLINE             = 'CLINE',              // Cline (saoudrizwan.claude-dev)
  AIDER             = 'AIDER',              // Aider CLI
  CONTINUE          = 'CONTINUE',           // Continue.dev
  GENERIC_AGENT     = 'GENERIC_AGENT',      // Multi-file burst, tool unknown
  UNKNOWN           = 'UNKNOWN',
}

export enum DetectionMethod {
  CO_AUTHOR_TRAILER   = 'CO_AUTHOR_TRAILER',
  LARGE_INSERTION     = 'LARGE_INSERTION',
  SHELL_WRAPPER       = 'SHELL_WRAPPER',
  FILE_WATCHER        = 'FILE_WATCHER',
  MULTI_FILE_BURST    = 'MULTI_FILE_BURST',
  EXTERNAL_FILE_WRITE = 'EXTERNAL_FILE_WRITE',
  MANUAL              = 'MANUAL',
}

export interface AttributionEntry {
  file: string;
  tool: AITool;
  confidence: 'high' | 'medium' | 'low';
  detectionMethod: DetectionMethod;
  linesStart: number;
  linesEnd: number;
  charsInserted: number;
  timestamp: string;
  sessionId: string;
  accepted: boolean;
}

export interface SessionLog {
  sessionId: string;
  startedAt: string;
  entries: AttributionEntry[];
}
