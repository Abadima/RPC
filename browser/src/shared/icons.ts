import type { IconDefinition } from "@fortawesome/free-solid-svg-icons";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A Font Awesome icon as inline SVG, straight from its path data: no icon
 * font or runtime library ships, only the icons a page imports. Decorative
 * (`aria-hidden`); the control or text next to it carries the meaning.
 */
export function icon(definition: IconDefinition): SVGSVGElement {
  const [width, height, , , paths] = definition.icon;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of Array.isArray(paths) ? paths : [paths]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Fills every `[data-icon]` placeholder under `root` from `icons`, by name. */
export function fillIcons(root: ParentNode, icons: Record<string, IconDefinition>): void {
  for (const slot of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const definition = icons[slot.dataset.icon ?? ""];
    if (definition) slot.replaceWith(icon(definition));
  }
}
