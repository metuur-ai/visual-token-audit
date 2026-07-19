// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
export type Kind = "prompt" | "assistant" | "tool_use" | "tool_result" | "system";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface MonitorEvent {
  id: number;
  ts: string;
  sessionId: string;
  project: string;
  kind: Kind;
  uuid?: string; // v2: transcript line uuid
  parentUuid?: string; // v2: transcript line parentUuid
  model?: string;
  usage?: Usage;
  tools?: string[];
  skill?: string;
  command?: string; // v2: slash command detected in a prompt
  rules?: string[]; // v2.4: rule files (.claude/rules/*.md) injected on a prompt line
  agent?: string; // v2: Task/Agent subagent_type
  sidechain?: boolean; // v2: line has isSidechain:true
  text?: string;
  cwd?: string; // v2.2: session working directory (from transcript line)
}

export interface SessionAgg {
  sessionId: string;
  project: string;
  cwd?: string; // v2.2: last-seen working directory of the session
  firstTs: string;
  lastTs: string;
  prompts: number;
  events: number;
  models: Record<string, number>;
  usage: Usage;
  tools: Record<string, number>;
  skills: Record<string, number>;
  commands: Record<string, number>; // v2
  rules: Record<string, number>; // v2.4
  agents: Record<string, number>; // v2
}

// v2: raw-ish parsed line retained per session for on-demand tree/attribution.
// Richer than MonitorEvent: keeps ordered tool_use blocks with their ids/inputs.
export interface ToolUseBlock {
  id: string; // toolu_… (may be "" if absent)
  name: string;
  input: any;
}
export interface SessionLine {
  ts: string;
  uuid?: string;
  parentUuid?: string;
  kind: Kind;
  model?: string;
  usage?: Usage;
  sidechain: boolean;
  agentId?: string; // v3.1: sub-agent id (from line field or subagents/agent-<id>.jsonl path)
  isMeta: boolean;
  command?: string; // slash command on a prompt line
  reminders: string[]; // system-reminder / hook evidence strings from user content
  text?: string; // prompt/tool_result/assistant text snippet
  toolUses: ToolUseBlock[]; // assistant tool_use blocks, in order
  toolResultFor?: string; // tool_use_id this line answers (tool_result lines)
  resultBytes?: number; // byte size of tool_result content
}

// v3.1 (task #11): sub-agent metadata harvested from subagents/agent-<id>.meta.json.
// toolUseId is the parent Task tool_use id — the exact link between a dedicated
// subagent transcript and the Task node in the parent session (verified on disk).
export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

// task #11: <projectDir>/<sessionId>/subagents/agent-<id>.jsonl → ids; null for
// ordinary top-level session transcripts.
export interface SubagentPath {
  parentSessionId: string;
  agentId: string;
}
