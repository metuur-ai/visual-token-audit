// ----------------------------------------------------------------------------
// v2: SessionDetail builder — deduplicated counts w/ token attribution,
// auto-vs-invoked classification, and a prompt-rooted invocation tree.
// Lazily built from the per-session bounded line store; cached until the
// store changes (storeSessionLine invalidates detailCache on new lines).
// ----------------------------------------------------------------------------




import { LABEL_LEN, TREE_MAX_NODES } from "./config.ts";
import { costUSD, priceFor } from "./cost.ts";
import { sessionLines, sessions, subagentMeta } from "./state.ts";
import { AgentDispatch, AutoLoad, CountMap, InvokedLoad, TreeNode, bump, chainDurationMs, chainModel, chainSubtree, chainToolCount, chainUsage, claimChain, classifyReminder, collectSidechainChains, countNodes, inputSummary, mcpServer, promptOf, ruleTokenEstimate, toolNodeKind } from "./tree.ts";
import { Usage } from "./types.ts";
import { clip, scaleUsage } from "./util.ts";

export function buildSessionDetail(sessionId: string): string | null {
  const agg = sessions.get(sessionId);
  const lines = sessionLines.get(sessionId);
  if (!agg || !lines || lines.length === 0) return null;

  // ----- index: tool_use_id → { result line, durationMs, resultBytes } -----
  // Map tool_use id → the emitting tool_use ts + block, then match results.
  const toolUseTs = new Map<string, number>(); // id → ts ms
  const resultFor = new Map<string, { ts: number; bytes: number }>();
  for (const ln of lines) {
    const tms = Date.parse(ln.ts);
    for (const tu of ln.toolUses) {
      if (tu.id) toolUseTs.set(tu.id, Number.isFinite(tms) ? tms : NaN);
    }
    if (ln.toolResultFor) {
      resultFor.set(ln.toolResultFor, {
        ts: Number.isFinite(tms) ? tms : NaN,
        bytes: ln.resultBytes ?? 0,
      });
    }
  }
  const durationOf = (id: string): number | undefined => {
    const a = toolUseTs.get(id);
    const r = resultFor.get(id);
    if (a === undefined || !r) return undefined;
    const d = r.ts - a;
    return Number.isFinite(d) && d >= 0 ? d : undefined;
  };

  // ----- scope tracking for token attribution -----
  // Active scopes: current slash-command (until next prompt), plus a stack of
  // open Skill scopes (innermost wins), plus agent sidechain (sidechain:true).
  // We attribute each assistant message's usage to the innermost active scope.
  const tools: CountMap = {};
  const skills: CountMap = {};
  const commands: CountMap = {};
  const rules: CountMap = {};
  const agents: CountMap = {};
  const mcp: CountMap = {};

  const invokedTools = new Map<string, number>();
  const invokedSkills = new Map<string, number>();
  const invokedCommands = new Map<string, number>();
  const invokedAgents = new Map<string, number>();
  const invokedMcp = new Map<string, number>();
  const autoMap = new Map<string, AutoLoad>(); // key: type|name

  let curCommand: string | undefined; // slash command active in current prompt turn
  const skillStack: string[] = []; // open Skill scopes (innermost last)
  // Open skill scope closes when its tool_result arrives; track by tool_use id.
  const openSkillById = new Map<string, string>(); // tool_use id → skill name

  for (const ln of lines) {
    // Auto-load evidence from user/prompt reminders.
    for (const ev of ln.reminders) {
      const a = classifyReminder(ev);
      const k = a.type + "|" + a.name;
      if (!autoMap.has(k)) autoMap.set(k, a);
      // v2.4: rules — count every injection; attribute the estimated context
      // load (file size / 4) once per unique rule, mirroring skill/command maps.
      if (a.type === "rule" && a.name !== "rule") {
        const first = !(a.name in rules);
        bump(rules, a.name, 1, first ? ruleTokenEstimate(agg.cwd, a.name) : undefined);
      }
    }

    if (ln.kind === "prompt") {
      // New prompt turn: reset command scope.
      curCommand = ln.command;
      if (ln.command) {
        bump(commands, ln.command, 1);
        invokedCommands.set(ln.command, (invokedCommands.get(ln.command) ?? 0) + 1);
      }
      continue;
    }

    if (ln.kind === "tool_result") {
      // Closing a skill scope if this result answers an open Skill tool_use.
      if (ln.toolResultFor && openSkillById.has(ln.toolResultFor)) {
        const sn = openSkillById.get(ln.toolResultFor)!;
        const idx = skillStack.lastIndexOf(sn);
        if (idx >= 0) skillStack.splice(idx, 1);
        openSkillById.delete(ln.toolResultFor);
      }
      continue;
    }

    if (ln.kind === "assistant") {
      const usage = ln.usage;
      // Innermost active scope wins for whole-message attribution:
      //   sidechain(agent) > skill > command.
      if (ln.sidechain) {
        // Sidechain lines belong to an agent; we can't always know which agent
        // from the line alone — attribute to a synthetic "sidechain" agent
        // bucket only if no better name. Most agent naming happens at the Task
        // tool_use (handled below); here we credit usage to the last agent seen.
        // Fall through: still divide tool usage per block below.
      } else if (skillStack.length) {
        bump(skills, skillStack[skillStack.length - 1], 0, usage);
      } else if (curCommand) {
        bump(commands, curCommand, 0, usage);
      }

      // Per-tool attribution: split this message's usage across its tool_use
      // blocks (divide by block count) so tool sums ≈ real totals.
      const n = ln.toolUses.length;
      const share = n > 0 ? scaleUsage(usage, 1 / n) : undefined;
      for (const tu of ln.toolUses) {
        const { kind, name } = toolNodeKind(tu);
        const srv = mcpServer(tu.name);
        if (kind === "skill") {
          bump(skills, name, 1, share);
          invokedSkills.set(name, (invokedSkills.get(name) ?? 0) + 1);
          // Namespaced skill ("plugin:skill-name") → the plugin auto-loaded it.
          const ns = name.includes(":") ? name.split(":")[0] : undefined;
          if (ns) {
            const k = "plugin|" + ns;
            if (!autoMap.has(k))
              autoMap.set(k, { type: "plugin", name: ns, evidence: `skill ${name} invoked` });
          }
          // Open a skill scope until its tool_result.
          if (tu.id) openSkillById.set(tu.id, name);
          skillStack.push(name);
        } else if (kind === "agent") {
          bump(agents, name, 1, share);
          invokedAgents.set(name, (invokedAgents.get(name) ?? 0) + 1);
        } else if (srv) {
          bump(mcp, srv, 1, share);
          invokedMcp.set(srv, (invokedMcp.get(srv) ?? 0) + 1);
          // MCP tools are also real tool calls; count in tools map too.
          bump(tools, tu.name, 1, share);
          invokedTools.set(tu.name, (invokedTools.get(tu.name) ?? 0) + 1);
        } else {
          bump(tools, name, 1, share);
          invokedTools.set(name, (invokedTools.get(name) ?? 0) + 1);
        }
      }
      continue;
    }
  }

  // ----- sidechain chains: one per sub-agent invocation (v2.2) -----
  const chains = collectSidechainChains(lines);
  const dispatches: AgentDispatch[] = [];

  // ----- invocation tree: one root per prompt, chronological -----
  const roots: TreeNode[] = [];
  let cur: TreeNode | null = null;
  let nodeCount = 0;
  const capped = () => nodeCount >= TREE_MAX_NODES;

  for (const ln of lines) {
    if (ln.sidechain) continue; // sidechain lines summarized under agent nodes, not top-level
    if (ln.kind === "prompt") {
      const isCmd = !!ln.command;
      cur = {
        kind: isCmd ? "command" : "prompt",
        name: isCmd ? ln.command! : "",
        ts: ln.ts,
        label: clip(ln.text ?? "", LABEL_LEN),
        children: [],
      };
      roots.push(cur);
      nodeCount++;
      continue;
    }
    if (!cur) continue; // events before any prompt in the window — skip
    if (capped()) continue;

    if (ln.kind === "assistant") {
      // Assistant text step (only add a node if it carries usage or text).
      const textLabel = clip(ln.text ?? "", LABEL_LEN);
      if (ln.usage || textLabel) {
        const an: TreeNode = {
          kind: "assistant",
          name: ln.model ?? "",
          ts: ln.ts,
          label: textLabel,
          ...(ln.usage ? { usage: ln.usage } : {}),
          children: [],
        };
        cur.children!.push(an);
        nodeCount++;
      }
      const n = ln.toolUses.length;
      const share = n > 0 ? scaleUsage(ln.usage, 1 / n) : undefined;
      for (const tu of ln.toolUses) {
        if (capped()) break;
        const { kind, name } = toolNodeKind(tu);
        const node: TreeNode = {
          kind,
          name,
          ts: ln.ts,
          label: inputSummary(tu.name, tu.input),
          ...(share ? { usage: share } : {}),
        };
        const dur = tu.id ? durationOf(tu.id) : undefined;
        if (dur !== undefined) node.durationMs = dur;
        const r = tu.id ? resultFor.get(tu.id) : undefined;
        if (r && r.bytes) node.resultBytes = r.bytes;
        if (kind === "agent") {
          const chain = claimChain(chains, promptOf(tu.input), ln.ts, tu.id || undefined);
          if (chain) {
            const total = chainUsage(chain);
            if (total) node.usage = total; // sub-agent's own token cost
            const sub = chainSubtree(chain);
            if (sub.length) node.children = sub;
            const model = chainModel(chain);
            const dur = chainDurationMs(chain);
            dispatches.push({
              agent: name,
              ts: chain.rootTs,
              ...(model ? { model } : {}),
              ...(total ? { usage: total, costUSD: costUSD(model, total) } : {}),
              toolCount: chainToolCount(chain),
              ...(dur !== undefined ? { durationMs: dur } : {}),
              label: clip(promptOf(tu.input) || chain.promptText, LABEL_LEN),
            });
          }
        }
        cur.children!.push(node);
        nodeCount++;
      }
      continue;
    }
  }

  // Cap: truncate oldest prompts first if over TREE_MAX_NODES.
  while (nodeCount > TREE_MAX_NODES && roots.length > 1) {
    const dropped = roots.shift()!;
    nodeCount -= countNodes(dropped);
  }

  // Chains never claimed by an Agent tool_use in the retained window still
  // represent sub-agent work — surface them as dispatches too. Dedicated
  // subagent files know their agent type from meta.json (task #11).
  for (const c of chains) {
    if (c.claimed) continue;
    const total = chainUsage(c);
    const model = chainModel(c);
    const dur = chainDurationMs(c);
    dispatches.push({
      agent: (c.agentId && subagentMeta.get(c.agentId)?.agentType) || "(sidechain)",
      ts: c.rootTs,
      ...(model ? { model } : {}),
      ...(total ? { usage: total, costUSD: costUSD(model, total) } : {}),
      toolCount: chainToolCount(c),
      ...(dur !== undefined ? { durationMs: dur } : {}),
      label: clip(c.promptText, LABEL_LEN),
    });
  }
  dispatches.sort((a, b) => a.ts.localeCompare(b.ts));

  // ----- session cost + context-window estimates (v2.3) -----
  const usageByModel = new Map<string, Usage>();
  let lastCtx: { model: string; tokens: number; ts: string } | null = null;
  for (const ln of lines) {
    if (!ln.usage || !ln.model) continue;
    let u = usageByModel.get(ln.model);
    if (!u) {
      u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      usageByModel.set(ln.model, u);
    }
    u.input += ln.usage.input;
    u.output += ln.usage.output;
    u.cacheRead += ln.usage.cacheRead;
    u.cacheWrite += ln.usage.cacheWrite;
    if (!ln.sidechain) {
      // Current context ≈ what the last main-chain call read:
      // fresh input + cache read + cache write.
      lastCtx = {
        model: ln.model,
        tokens: ln.usage.input + ln.usage.cacheRead + ln.usage.cacheWrite,
        ts: ln.ts,
      };
    }
  }
  const byModel = [...usageByModel]
    .map(([model, u]) => ({ model, usage: u, costUSD: costUSD(model, u) }))
    .sort((a, b) => b.costUSD - a.costUSD);
  const byCategory = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const [model, u] of usageByModel) {
    const p = priceFor(model);
    byCategory.input += (u.input * p.input) / 1e6;
    byCategory.output += (u.output * p.output) / 1e6;
    byCategory.cacheRead += (u.cacheRead * p.input * 0.1) / 1e6;
    byCategory.cacheWrite += (u.cacheWrite * p.input * 1.25) / 1e6;
  }
  const totalUSD = byModel.reduce((s, m) => s + m.costUSD, 0);

  const auto = Array.from(autoMap.values());
  const invoked: InvokedLoad[] = [
    ...[...invokedSkills].map(([name, count]) => ({ type: "skill" as const, name, count })),
    ...[...invokedCommands].map(([name, count]) => ({ type: "command" as const, name, count })),
    ...[...invokedAgents].map(([name, count]) => ({ type: "agent" as const, name, count })),
    ...[...invokedMcp].map(([name, count]) => ({ type: "mcp" as const, name, count })),
    ...[...invokedTools].map(([name, count]) => ({ type: "tool" as const, name, count })),
  ];

  const detail = {
    sessionId: agg.sessionId,
    project: agg.project,
    ...(agg.cwd ? { cwd: agg.cwd } : {}),
    ...(lastCtx ? { context: lastCtx } : {}),
    cost: { totalUSD, byModel, byCategory },
    dispatches,
    firstTs: agg.firstTs,
    lastTs: agg.lastTs,
    prompts: agg.prompts,
    usage: agg.usage,
    tools,
    skills,
    commands,
    rules,
    agents,
    mcp,
    loading: { auto, invoked },
    tree: roots,
  };
  return JSON.stringify(detail);
}
