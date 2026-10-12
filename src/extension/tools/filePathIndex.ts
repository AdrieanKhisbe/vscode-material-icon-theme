type Directory = {
  files: Set<string>;
  children: Set<string>;
};

const parentOf = (key: string): string | undefined => {
  const slash = key.lastIndexOf('/');
  return slash < 0 ? undefined : key.slice(0, slash);
};

/** Index direct children so deleting a directory visits only its subtree. */
export class FilePathIndex {
  private readonly files = new Map<string, string>();
  private readonly directories = new Map<string, Directory>();

  add(key: string, name: string): boolean {
    if (this.files.has(key)) return false;
    this.files.set(key, name);
    let child = parentOf(key);
    if (child === undefined) return true;
    const existing = this.directories.get(child);
    if (existing) {
      existing.files.add(key);
      return true;
    }
    this.directories.set(child, { files: new Set([key]), children: new Set() });
    while (true) {
      const parent = parentOf(child);
      if (parent === undefined) break;
      const directory = this.directories.get(parent);
      if (directory) {
        directory.children.add(child);
        break;
      }
      this.directories.set(parent, {
        files: new Set(),
        children: new Set([child]),
      });
      child = parent;
    }
    return true;
  }

  remove(key: string): string[] {
    const name = this.files.get(key);
    if (name !== undefined) {
      this.files.delete(key);
      const parent = parentOf(key);
      if (parent !== undefined) {
        this.directories.get(parent)?.files.delete(key);
        this.prune(parent);
      }
      return [name];
    }

    // Normalize a directory's trailing separator without collapsing URI roots
    // or mixing different schemes and remote authorities.
    const root = key.endsWith('/') ? key.slice(0, -1) : key;
    if (!this.directories.has(root)) return [];
    const removed: string[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const directoryKey = pending.pop()!;
      const directory = this.directories.get(directoryKey)!;
      for (const child of directory.children) pending.push(child);
      for (const file of directory.files) {
        removed.push(this.files.get(file)!);
        this.files.delete(file);
      }
      this.directories.delete(directoryKey);
    }
    const parent = parentOf(root);
    if (parent !== undefined) {
      this.directories.get(parent)?.children.delete(root);
      this.prune(parent);
    }
    return removed;
  }

  clear(): void {
    this.files.clear();
    this.directories.clear();
  }

  private prune(key: string): void {
    let current: string | undefined = key;
    while (current !== undefined) {
      const directory = this.directories.get(current);
      if (!directory || directory.files.size > 0 || directory.children.size > 0)
        return;
      this.directories.delete(current);
      const parent = parentOf(current);
      if (parent !== undefined)
        this.directories.get(parent)?.children.delete(current);
      current = parent;
    }
  }
}
