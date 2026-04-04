import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

interface RegisteredCommand {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface RegisteredShortcut {
  handler: (ctx: ExtensionContext) => Promise<void>;
}

export interface Harness {
  pi: ExtensionAPI;
  commands: Map<string, RegisteredCommand>;
  shortcuts: Map<string, RegisteredShortcut>;
  eventHandlers: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
}

export function createHarness(): Harness {
  const commands = new Map<string, RegisteredCommand>();
  const shortcuts = new Map<string, RegisteredShortcut>();
  const eventHandlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();

  const pi = {
    on: (eventName: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const handlers = eventHandlers.get(eventName) ?? [];
      handlers.push(handler);
      eventHandlers.set(eventName, handlers);
    },
    registerCommand: (name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    },
    registerShortcut: (shortcut: string, registeredShortcut: RegisteredShortcut) => {
      shortcuts.set(shortcut, registeredShortcut);
    },
  } as unknown as ExtensionAPI;

  return { pi, commands, shortcuts, eventHandlers };
}

export function createCommandContext(options?: {
  hasUI?: boolean;
  editorText?: string;
}): ExtensionCommandContext & {
  notifications: string[];
  setEditorTextCalls: string[];
  waitForIdleCalls: number;
  reloadCalls: number;
} {
  const notifications: string[] = [];
  const setEditorTextCalls: string[] = [];
  let editorText = options?.editorText ?? "";
  let waitForIdleCalls = 0;
  let reloadCalls = 0;

  return {
    hasUI: options?.hasUI ?? true,
    cwd: "/work/project",
    notifications,
    setEditorTextCalls,
    get waitForIdleCalls() {
      return waitForIdleCalls;
    },
    get reloadCalls() {
      return reloadCalls;
    },
    waitForIdle: async () => {
      waitForIdleCalls += 1;
    },
    reload: async () => {
      reloadCalls += 1;
    },
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
      getEditorText: () => editorText,
      setEditorText: (value: string) => {
        editorText = value;
        setEditorTextCalls.push(value);
      },
    },
  } as unknown as ExtensionCommandContext & {
    notifications: string[];
    setEditorTextCalls: string[];
    waitForIdleCalls: number;
    reloadCalls: number;
  };
}

export function createShortcutContext(options?: {
  hasUI?: boolean;
  editorText?: string;
  idle?: boolean;
}) {
  const notifications: string[] = [];
  const setEditorTextCalls: string[] = [];
  let editorText = options?.editorText ?? "";

  return {
    hasUI: options?.hasUI ?? true,
    cwd: "/work/project",
    notifications,
    setEditorTextCalls,
    isIdle: () => options?.idle ?? true,
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
      getEditorText: () => editorText,
      setEditorText: (value: string) => {
        editorText = value;
        setEditorTextCalls.push(value);
      },
    },
  } as unknown as ExtensionContext & {
    notifications: string[];
    setEditorTextCalls: string[];
  };
}
