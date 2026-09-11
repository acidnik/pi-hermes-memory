/**
 * Shared collapsible, clickable chat block for extensions.
 *
 * Renders collapsed content (e.g. "N entries") and, on expansion (the
 * standard app.tools.expand key, default ctrl+o, OR a left click via
 * MouseRegion — the same mechanism tool-output blocks use), the full content.
 */

import { Container, Text, getKeybindings, type Component } from "@earendil-works/pi-tui";
import * as piTui from "@earendil-works/pi-tui";

export interface CollapsibleBlockState {
  collapsed: string[];
  expanded: string[];
}

/** The key that toggles expanded output (same one tool results use). */
export function expandHint(): string {
  try {
    const keybindings = getKeybindings() as unknown as {
      getKeys?: (keybinding: string) => unknown;
    };
    const keys = keybindings?.getKeys?.("app.tools.expand");
    const first = Array.isArray(keys) ? keys[0] : keys;
    if (typeof first === "string") return first;
    const key = (first as { key?: unknown } | undefined)?.key;
    if (typeof key === "string") return key;
  } catch { /* fall through */ }
  return "ctrl+o";
}

/**
 * A Container hosting a MouseRegion-wrapped Text. A left click toggles the
 * block's own collapsed/expanded state; ctrl+o (app.tools.expand) keeps
 * working through the host's global toggle. Falls back to keyboard-only on
 * hosts whose pi-tui lacks MouseRegion.
 */
export class CollapsibleBlockComponent extends Container {
  private expanded: boolean;

  constructor(
    private readonly state: () => CollapsibleBlockState,
    initialExpanded: boolean,
  ) {
    super();
    this.expanded = initialExpanded;
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();
    const text = new Text(
      (this.expanded ? this.state().expanded : this.state().collapsed).join("\n"),
      1,
      0,
    );
    const MouseRegion = (piTui as { MouseRegion?: unknown }).MouseRegion as
      | (new (child: Component, onMouse: (event: any) => any) => Component)
      | undefined;
    if (typeof MouseRegion === "function") {
      this.addChild(new MouseRegion(text, (event: any) => {
        if (event?.type !== "click" || event?.button !== "left") return undefined;
        this.expanded = !this.expanded;
        this.rebuild();
        this.invalidate();
        return { handled: true };
      }));
    } else {
      this.addChild(text);
    }
  }
}