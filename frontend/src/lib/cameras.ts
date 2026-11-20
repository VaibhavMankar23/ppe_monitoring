/** Cameras are listed in natural order: numbers in ascending order (86, 100, 114, not 100, 114, 86), then names with
 * letters, and mixed names such as "Gate 2" and "Gate 10" by their numbers. Case does not matter. It depends only on
 * the camera's name, never on its status, so a tile never moves because a camera went down or came back. */
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

interface Named {
  id: string;
  name?: string;
}

export function compareCameras(a: Named, b: Named): number {
  return collator.compare(String(a.name || a.id), String(b.name || b.id)) || collator.compare(String(a.id), String(b.id));
}

export function sortCameras<T extends Named>(cameras: readonly T[]): T[] {
  return [...cameras].sort(compareCameras);
}
