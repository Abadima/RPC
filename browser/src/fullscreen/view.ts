import { translateTree } from "../core/i18n";
import type { PresenceSnapshot } from "../shared/presence-view";
import type { ActivityInfo } from "../core/activity";
import type { ConnectionState } from "../core/desktop-connection";
import type { SettingsActions, SettingsContext } from "../shared/settings-view";

export interface ShellState {
  /** As shown: lags the real state while a retry is in flight (see displayedState). */
  connection: ConnectionState;
  checking: boolean;
  /** The current tab's Activity, as Privacy settings let it be shared; `null` until checked. */
  snapshot: PresenceSnapshot | null;
  settings: SettingsContext;
}

export interface ViewContext {
  catalog(): Promise<readonly ActivityInfo[]>;
  settings: SettingsActions;
  reconnect(): void;
  origin: string;
}

export interface View {
  title: string;
  element: HTMLElement;
  update(shell: ShellState): void;
  mounted?(): void;
  destroy?(): void;
}

export function fromTemplate(name: string): HTMLElement {
  const template = document.getElementById(`view-${name}`);
  const element =
    template instanceof HTMLTemplateElement
      ? template.content.firstElementChild?.cloneNode(true)
      : null;
  if (!(element instanceof HTMLElement))
    throw new Error(`fullscreen.html is missing #view-${name}`);
  translateTree(element);
  return element;
}

export function slot<T extends HTMLElement = HTMLElement>(root: ParentNode, name: string): T {
  const element = root.querySelector<T>(`[data-slot="${name}"]`);
  if (!element) throw new Error(`missing slot ${name}`);
  return element;
}
