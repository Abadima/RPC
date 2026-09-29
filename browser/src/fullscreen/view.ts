import type { PresenceSnapshot } from "../../../packages/presence-view/mount";
import type { ActivityInfo } from "../core/activity";
import type { ConnectionState } from "../core/desktop-connection";
import type { SettingsActions, SettingsContext } from "../shared/settings-view";

/** Everything a dashboard page shows, kept by the shell and handed to the page on show. */
export interface ShellState {
  /** As shown: lags the real state while a retry is in flight (see displayedState). */
  connection: ConnectionState;
  /** A retry is in flight while Desktop is missing. */
  checking: boolean;
  /** The current tab's Activity, as Privacy settings let it be shared; `null` until checked. */
  snapshot: PresenceSnapshot | null;
  settings: SettingsContext;
}

/** What a page can do or look up, beyond what it's shown. */
export interface ViewContext {
  activities: readonly ActivityInfo[];
  settings: SettingsActions;
  reconnect(): void;
  /** This extension's origin, for the "allow this build" command. */
  origin: string;
}

/** A dashboard page: built on show, updated while shown, dropped on leaving. */
export interface View {
  title: string;
  element: HTMLElement;
  update(shell: ShellState): void;
  /** Called once it's on screen, for anything that needs to measure the layout. */
  mounted?(): void;
  /** Called when leaving the page. */
  destroy?(): void;
}

/** A copy of `<template id="view-…">`'s content, as one element. */
export function fromTemplate(name: string): HTMLElement {
  const template = document.getElementById(`view-${name}`);
  const element =
    template instanceof HTMLTemplateElement
      ? template.content.firstElementChild?.cloneNode(true)
      : null;
  if (!(element instanceof HTMLElement))
    throw new Error(`fullscreen.html is missing #view-${name}`);
  return element;
}

/** The `[data-slot=name]` element inside `root`. */
export function slot<T extends HTMLElement = HTMLElement>(root: ParentNode, name: string): T {
  const element = root.querySelector<T>(`[data-slot="${name}"]`);
  if (!element) throw new Error(`missing slot ${name}`);
  return element;
}
