import { generateCoachPlan } from './coach-generator';
import { inferCaptureSuggestions } from './capture-inference';
import {
  capabilities,
  coachPlan,
  defaultCaptureDraft,
  defaultSuggestions,
  userProfile,
  weeklySummary,
} from './mock-data';
import { createModelCallTrace } from './model-telemetry';
import { generateWeeklyMarkdown } from './reflection-generator';
import type { ToolConnector, WorkspaceState } from '../types/domain';

const STORAGE_KEY = 'pm-growth-os.workspace.v1';

type ConnectorPatch = {
  enabled?: boolean;
  status?: ToolConnector['status'];
  mcpEndpoint?: string;
  accountHint?: string;
};

const initialToolConnectors: ToolConnector[] = [
  {
    id: 'local-ai',
    name: 'Local AI Heuristics',
    category: 'llm',
    method: 'local',
    status: 'enabled',
    scope: 'platform',
    description:
      'Runs capture inference, coach planning, reflection drafting, and token estimates in the browser.',
    useCases: ['Capture suggestions', 'Coach plan generation', 'Weekly reflection draft'],
    requiredInputs: ['No setup required'],
    enabled: true,
  },
  {
    id: 'browser-storage',
    name: 'Browser Local Storage',
    category: 'knowledge',
    method: 'local',
    status: 'enabled',
    scope: 'platform',
    description: 'Persists notes, growth state, reflection drafts, and traces in this browser.',
    useCases: ['Offline usage', 'Static Vercel deployment', 'Private local workspace'],
    requiredInputs: ['No setup required'],
    enabled: true,
  },
  {
    id: 'markdown-export',
    name: 'Markdown Export',
    category: 'export',
    method: 'local',
    status: 'enabled',
    scope: 'platform',
    description: 'Exports notes and trace data without an external account.',
    useCases: ['Export notes', 'Export model traces', 'Copy weekly reflections'],
    requiredInputs: ['No setup required'],
    enabled: true,
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'knowledge',
    method: 'account',
    status: 'needs_account',
    scope: 'user',
    description: 'Optional future sync target for notes and learning summaries.',
    useCases: ['Import historical notes', 'Export weekly reports', 'Build a knowledge base'],
    requiredInputs: ['Notion integration token', 'Database ID'],
    accountHint: 'Static mode stores this setup hint locally. Real sync requires a serverless connector.',
    enabled: false,
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'workflow',
    method: 'account',
    status: 'needs_account',
    scope: 'user',
    description: 'Optional future connector for issues, PRs, and project evidence.',
    useCases: ['Import issue notes', 'Track shipping evidence', 'Generate project retrospectives'],
    requiredInputs: ['GitHub token or GitHub MCP server'],
    accountHint: 'Static mode does not call GitHub directly. Use this as a local setup note for now.',
    enabled: false,
  },
];

let memoryWorkspace: WorkspaceState | null = null;

export async function fetchWorkspace() {
  return readWorkspace();
}

export async function resetWorkspaceApi() {
  const workspace = createInitialWorkspace();
  return writeWorkspace(workspace);
}

export async function createNoteApi(content: string) {
  const normalizedContent = content.trim();

  if (!normalizedContent) {
    throw new Error('Note content is required.');
  }

  return updateWorkspace((current) => {
    const suggestions = inferCaptureSuggestions(normalizedContent, current.capabilities);
    const now = new Date().toISOString();
    const trace = createModelCallTrace({
      agent: 'Capture Agent',
      operation: 'infer_capture_suggestions',
      prompt: normalizedContent,
      completion: JSON.stringify(suggestions),
    });
    const note = {
      id: createId(),
      content: normalizedContent,
      createdAt: now,
      relatedCapabilityIds: suggestions.relatedCapabilities.map((item) => item.id),
      tags: suggestions.tags,
    };
    const nextCapabilities = current.capabilities.map((capability) => {
      if (!note.relatedCapabilityIds.includes(capability.id)) return capability;

      const nextProgress = Math.min(capability.progress + 6, 100);
      return {
        ...capability,
        progress: nextProgress,
        evidenceCount: capability.evidenceCount + 1,
        stageLabel: getStageLabel(nextProgress),
        updatedAt: now.slice(0, 10),
      };
    });

    return {
      ...current,
      capabilities: nextCapabilities,
      captureDraft: '',
      captureSuggestions: inferCaptureSuggestions('', nextCapabilities),
      modelTraces: [trace, ...current.modelTraces],
      notes: [note, ...current.notes],
      userProfile: {
        ...current.userProfile,
        focusArea: suggestions.relatedCapabilities[0]?.name ?? current.userProfile.focusArea,
        savedNotes: current.userProfile.savedNotes + 1,
        lastInsight: suggestions.nextPrompt,
      },
    };
  });
}

export async function deleteNoteApi(noteId: string) {
  return updateWorkspace((current) => {
    const note = current.notes.find((item) => item.id === noteId);
    if (!note) return current;

    return {
      ...current,
      capabilities: current.capabilities.map((capability) => {
        if (!note.relatedCapabilityIds.includes(capability.id)) return capability;

        const nextProgress = Math.max(capability.progress - 6, 0);
        return {
          ...capability,
          evidenceCount: Math.max(capability.evidenceCount - 1, 0),
          progress: nextProgress,
          stageLabel: getStageLabel(nextProgress),
        };
      }),
      notes: current.notes.filter((item) => item.id !== noteId),
      userProfile: {
        ...current.userProfile,
        savedNotes: Math.max(current.userProfile.savedNotes - 1, 0),
      },
    };
  });
}

export async function generateCoachPlanApi(capabilityId?: string) {
  return updateWorkspace((current) => {
    const nextPlan = generateCoachPlan({
      capabilities: current.capabilities,
      notes: current.notes,
      targetCapabilityId: capabilityId,
      userProfile: current.userProfile,
    });
    const targetCapability = current.capabilities.find((item) => item.id === capabilityId);
    const trace = createModelCallTrace({
      agent: 'Coach Agent',
      operation: capabilityId ? 'generate_capability_coach_plan' : 'generate_coach_plan',
      prompt: JSON.stringify({
        targetCapability,
        capabilities: current.capabilities,
        recentNotes: current.notes.slice(0, 3),
        userProfile: current.userProfile,
      }),
      completion: JSON.stringify(nextPlan),
    });

    return {
      ...current,
      coachPlan: nextPlan,
      modelTraces: [trace, ...current.modelTraces],
      selectedCapabilityId: capabilityId ?? current.selectedCapabilityId,
      userProfile: {
        ...current.userProfile,
        focusArea: targetCapability?.name ?? current.userProfile.focusArea,
        lastInsight: nextPlan.steps[0]?.detail ?? current.userProfile.lastInsight,
      },
    };
  });
}

export async function sendCoachStepToCaptureApi(stepId: string) {
  return updateWorkspace((current) => {
    const step = current.coachPlan.steps.find((item) => item.id === stepId);
    if (!step) return current;

    const nextDraft = [
      `探索任务：${step.title}`,
      '',
      step.detail,
      '',
      '我的实践记录：',
    ].join('\n');
    const trace = createModelCallTrace({
      agent: 'Coach Agent',
      operation: 'handoff_step_to_capture',
      prompt: JSON.stringify(step),
      completion: nextDraft,
    });

    return {
      ...current,
      captureDraft: nextDraft,
      captureSuggestions: inferCaptureSuggestions(nextDraft, current.capabilities),
      coachPlan: {
        ...current.coachPlan,
        steps: current.coachPlan.steps.map((item) =>
          item.id === stepId ? { ...item, status: 'active' } : item,
        ),
      },
      modelTraces: [trace, ...current.modelTraces],
    };
  });
}

export async function sendCapabilityToCaptureApi(capabilityId: string) {
  return updateWorkspace((current) => {
    const capability = current.capabilities.find((item) => item.id === capabilityId);
    if (!capability) return current;

    const nextDraft = [
      `能力探索：${capability.name}`,
      '',
      `当前阶段：${capability.stageLabel}`,
      `当前进度：${capability.progress}%`,
      '',
      '我今天遇到的真实场景：',
      '',
      '我想验证的问题：',
    ].join('\n');
    const trace = createModelCallTrace({
      agent: 'Profile Agent',
      operation: 'handoff_capability_to_capture',
      prompt: JSON.stringify(capability),
      completion: nextDraft,
    });

    return {
      ...current,
      captureDraft: nextDraft,
      captureSuggestions: inferCaptureSuggestions(nextDraft, current.capabilities),
      modelTraces: [trace, ...current.modelTraces],
      selectedCapabilityId: capabilityId,
    };
  });
}

export async function sendNoteToCaptureApi(noteId: string) {
  return updateWorkspace((current) => {
    const note = current.notes.find((item) => item.id === noteId);
    if (!note) return current;

    return {
      ...current,
      captureDraft: note.content,
      captureSuggestions: inferCaptureSuggestions(note.content, current.capabilities),
    };
  });
}

export async function selectCapabilityApi(capabilityId: string) {
  return updateWorkspace((current) => ({
    ...current,
    selectedCapabilityId: capabilityId,
  }));
}

export async function updateCaptureDraftApi(draft: string) {
  return updateWorkspace((current) => ({
    ...current,
    captureDraft: draft,
    captureSuggestions: inferCaptureSuggestions(draft, current.capabilities),
  }));
}

export async function generateReflectionDraftApi() {
  return updateWorkspace((current) => {
    const reflectionDraft = generateWeeklyMarkdown(current);
    const trace = createModelCallTrace({
      agent: 'Reflection Agent',
      operation: 'generate_weekly_markdown',
      prompt: JSON.stringify({
        notes: current.notes.slice(0, 5),
        userProfile: current.userProfile,
        weeklySummary: current.weeklySummary,
      }),
      completion: reflectionDraft,
    });

    return {
      ...current,
      reflectionDraft,
      modelTraces: [trace, ...current.modelTraces],
    };
  });
}

export async function updateReflectionDraftApi(draft: string) {
  return updateWorkspace((current) => ({
    ...current,
    reflectionDraft: draft,
  }));
}

export async function clearModelTracesApi() {
  return updateWorkspace((current) => ({
    ...current,
    modelTraces: [],
  }));
}

export async function updateConnectorApi(connectorId: string, payload: ConnectorPatch) {
  return updateWorkspace((current) => ({
    ...current,
    toolConnectors: current.toolConnectors.map((connector) => {
      if (connector.id !== connectorId) return connector;

      const nextConnector = {
        ...connector,
        ...payload,
        updatedAt: new Date().toISOString(),
      };

      if (nextConnector.enabled && nextConnector.status === 'not_connected') {
        nextConnector.status =
          nextConnector.method === 'account' ? 'needs_account' : 'configured';
      }

      return nextConnector;
    }),
  }));
}

function readWorkspace(): WorkspaceState {
  const storage = getStorage();

  if (!storage) {
    if (!memoryWorkspace) {
      memoryWorkspace = createInitialWorkspace();
    }

    return memoryWorkspace;
  }

  const raw = storage.getItem(STORAGE_KEY);

  if (!raw) {
    const workspace = createInitialWorkspace();
    storage.setItem(STORAGE_KEY, JSON.stringify(workspace));
    return workspace;
  }

  try {
    return normalizeWorkspace(JSON.parse(raw) as Partial<WorkspaceState>);
  } catch {
    const workspace = createInitialWorkspace();
    storage.setItem(STORAGE_KEY, JSON.stringify(workspace));
    return workspace;
  }
}

function writeWorkspace(workspace: WorkspaceState): WorkspaceState {
  const nextWorkspace = {
    ...workspace,
    updatedAt: new Date().toISOString(),
  };
  const storage = getStorage();

  if (!storage) {
    memoryWorkspace = nextWorkspace;
    return nextWorkspace;
  }

  storage.setItem(STORAGE_KEY, JSON.stringify(nextWorkspace));
  return nextWorkspace;
}

function updateWorkspace(updater: (workspace: WorkspaceState) => WorkspaceState) {
  const current = readWorkspace();
  return writeWorkspace(updater(current));
}

function createInitialWorkspace(): WorkspaceState {
  return {
    capabilities: clone(capabilities),
    captureDraft: defaultCaptureDraft,
    captureSuggestions: clone(defaultSuggestions),
    coachPlan: clone(coachPlan),
    modelTraces: [],
    notes: [],
    reflectionDraft: '',
    selectedCapabilityId: capabilities[0]?.id ?? '',
    toolConnectors: clone(initialToolConnectors),
    weeklySummary: clone(weeklySummary),
    userProfile: clone(userProfile),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeWorkspace(workspace: Partial<WorkspaceState>): WorkspaceState {
  const initial = createInitialWorkspace();

  return {
    ...initial,
    ...workspace,
    capabilities: workspace.capabilities ?? initial.capabilities,
    captureSuggestions: workspace.captureSuggestions ?? initial.captureSuggestions,
    coachPlan: workspace.coachPlan ?? initial.coachPlan,
    modelTraces: workspace.modelTraces ?? [],
    notes: workspace.notes ?? [],
    toolConnectors: mergeToolConnectors(workspace.toolConnectors, initial.toolConnectors),
    weeklySummary: workspace.weeklySummary ?? initial.weeklySummary,
    userProfile: {
      ...initial.userProfile,
      ...(workspace.userProfile ?? {}),
    },
  };
}

function mergeToolConnectors(
  existing: ToolConnector[] = [],
  latest: ToolConnector[] = [],
): ToolConnector[] {
  const existingById = new Map(existing.map((connector) => [connector.id, connector]));

  return latest.map((connector) => {
    const existingConnector = existingById.get(connector.id);

    if (!existingConnector) {
      return connector;
    }

    return {
      ...connector,
      status: existingConnector.status ?? connector.status,
      enabled: existingConnector.enabled ?? connector.enabled,
      mcpEndpoint: existingConnector.mcpEndpoint ?? connector.mcpEndpoint,
      accountHint: existingConnector.accountHint ?? connector.accountHint,
      updatedAt: existingConnector.updatedAt,
    };
  });
}

function getStorage() {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getStageLabel(progress: number) {
  if (progress >= 75) return '精通冲刺';
  if (progress >= 45) return '进阶';
  if (progress > 0) return '入门';
  return '未探索';
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random()}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
