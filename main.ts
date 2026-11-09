import { Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import type { App, TAbstractFile } from 'obsidian';

import { applyBlock, buildBlock, indexFileName, isExcluded, parentOf, parseRules, upToDate } from './src/index-note.ts';
import type { IndexItem, SortOrder } from './src/index-note.ts';

interface FolderIndexSettings {
  /** Keep existing index notes current as notes come and go. */
  autoUpdate: boolean;
  /** Also create an index note in a folder that has none. */
  autoCreate: boolean;
  /** Index file name; {{folder}} is the folder's name. */
  nameTemplate: string;
  order: SortOrder;
  foldersHeading: string;
  notesHeading: string;
  /** One folder per line; "Folder/*" covers its subfolders too. */
  excluded: string;
}

const DEFAULT_SETTINGS: FolderIndexSettings = {
  autoUpdate: true,
  autoCreate: false,
  nameTemplate: '_Index of {{folder}}',
  order: 'name',
  foldersHeading: 'Folders',
  notesHeading: 'Notes',
  excluded: '',
};

/** Shows what a bulk run will touch and waits for a yes. */
class ConfirmModal extends Modal {
  private chosen = false;

  constructor(app: App, private readonly message: string, private readonly onChoice: (ok: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Update folder indexes');
    this.contentEl.createEl('p', { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText('Continue')
          .setCta()
          .onClick(() => {
            this.chosen = true;
            this.onChoice(true);
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.chosen) this.onChoice(false);
  }
}

export default class FolderIndexNotesPlugin extends Plugin {
  settings: FolderIndexSettings = { ...DEFAULT_SETTINGS };
  private pending = new Set<string>();
  private timer: number | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new FolderIndexSettingTab(this.app, this));

    this.addCommand({
      id: 'update-folder-index',
      name: "Update this note's folder index",
      icon: 'list-tree',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) void this.safeUpdate(parentOf(file.path), true).then((r) => new Notice(r === 'none' ? 'Nothing to index here: the folder is excluded, empty or could not be updated.' : 'Folder index updated.'));
        return true;
      },
    });

    this.addCommand({
      id: 'update-all-indexes',
      name: 'Create or update indexes in all folders',
      icon: 'folder-sync',
      callback: () => void this.updateEverything(),
    });

    this.app.workspace.onLayoutReady(() => {
      // Registered after layout is ready so the vault's start-up "create"
      // events for every existing file do not trigger a run.
      this.registerEvent(this.app.vault.on('create', (f) => this.touched(f)));
      this.registerEvent(this.app.vault.on('delete', (f) => this.touched(f)));
      this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
        if (f instanceof TFolder) void this.renameIndexWith(f, oldPath);
        this.touched(f);
        this.queue(parentOf(oldPath));
      }));
    });
  }

  onunload() {
    if (this.timer !== null) window.clearTimeout(this.timer);
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<FolderIndexSettings> | null) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** A renamed folder takes its index note along, under the new name. */
  private async renameIndexWith(folder: TFolder, oldPath: string) {
    try {
      // Obsidian updates the children's paths just after this event fires.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      const oldName = oldPath.split('/').pop() ?? oldPath;
      const oldFile = indexFileName(oldName, this.settings.nameTemplate);
      // By name among the children: their paths may not be updated yet when the event fires.
      const old = folder.children.find((c): c is TFile => c instanceof TFile && c.name === oldFile) ?? null;
      const target = this.indexPath(folder);
      if (old && old.path !== target && !this.app.vault.getFileByPath(target)) await this.app.vault.rename(old, target);
      this.queue(folder.path);
    } catch (e) {
      console.error('Folder Index Notes: could not rename the index note', e);
    }
  }

  private touched(file: TAbstractFile) {
    if (!this.settings.autoUpdate) return;
    if (file instanceof TFile && file.extension !== 'md') return;
    if (file instanceof TFile && this.isIndexFile(file)) return;
    this.queue(parentOf(file.path));
  }

  private queue(folderPath: string) {
    this.pending.add(folderPath);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 1500);
  }

  private async flush() {
    this.timer = null;
    const folders = [...this.pending];
    this.pending.clear();
    for (const path of folders) await this.safeUpdate(path, false);
  }

  private folderOf(path: string): TFolder | null {
    if (path === '') return this.app.vault.getRoot();
    return this.app.vault.getFolderByPath(path);
  }

  private folderName(folder: TFolder): string {
    return folder.isRoot() ? this.app.vault.getName() : folder.name;
  }

  private indexPath(folder: TFolder): string {
    const name = indexFileName(this.folderName(folder), this.settings.nameTemplate);
    return folder.isRoot() ? name : `${folder.path}/${name}`;
  }

  private isIndexFile(file: TFile): boolean {
    const folder = file.parent;
    return !!folder && this.indexPath(folder) === file.path;
  }

  /**
   * Writes the folder's index. `force` creates it when missing; otherwise an
   * index is only created when "create automatically" is on. Returns what
   * happened. Walks up so a new subfolder index shows in its parent.
   */
  private async updateFolder(path: string, force: boolean): Promise<'created' | 'updated' | 'same' | 'none'> {
    const folder = this.folderOf(path);
    if (!folder) return 'none';
    if (isExcluded(folder.path, parseRules(this.settings.excluded))) return 'none';
    const indexPath = this.indexPath(folder);
    const existing = this.app.vault.getFileByPath(indexPath);
    if (!existing && !force && !this.settings.autoCreate) return 'none';

    const notes: IndexItem[] = [];
    const folders: IndexItem[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile) {
        if (child.extension !== 'md' || child.path === indexPath) continue;
        notes.push({ name: child.basename, link: this.app.fileManager.generateMarkdownLink(child, indexPath) });
      } else if (child instanceof TFolder) {
        const childIndex = this.app.vault.getFileByPath(this.indexPath(child));
        if (childIndex) folders.push({ name: child.name, link: this.app.fileManager.generateMarkdownLink(childIndex, indexPath, undefined, child.name) });
      }
    }
    const block = buildBlock({
      folders,
      notes,
      order: this.settings.order,
      foldersHeading: this.settings.foldersHeading,
      notesHeading: this.settings.notesHeading,
    });

    if (!existing) {
      if (notes.length === 0 && folders.length === 0) return 'none';
      await this.app.vault.create(indexPath, applyBlock(null, block));
      if (!folder.isRoot()) this.queue(parentOf(folder.path));
      return 'created';
    }
    let changed = false;
    await this.app.vault.process(existing, (text) => {
      if (upToDate(text, block)) return text;
      changed = true;
      return applyBlock(text, block);
    });
    return changed ? 'updated' : 'same';
  }

  /** One folder failing (a bad name, a clash) must not stop the others. */
  private async safeUpdate(path: string, force: boolean): Promise<'created' | 'updated' | 'same' | 'none'> {
    try {
      return await this.updateFolder(path, force);
    } catch (e) {
      console.error(`Folder Index Notes: could not update the index of "${path}"`, e);
      return 'none';
    }
  }

  private allFolders(): TFolder[] {
    const out: TFolder[] = [];
    const walk = (f: TFolder) => {
      out.push(f);
      for (const c of f.children) if (c instanceof TFolder) walk(c);
    };
    walk(this.app.vault.getRoot());
    // Deepest first, so each parent lists the indexes its children just got.
    return out.sort((a, b) => b.path.split('/').length - a.path.split('/').length);
  }

  private async updateEverything() {
    const rules = parseRules(this.settings.excluded);
    const targets = this.allFolders().filter((f) => !isExcluded(f.path, rules) && f.children.some((c) => c instanceof TFile && c.extension === 'md'));
    if (targets.length === 0) {
      new Notice('No folders with notes to index.');
      return;
    }
    const ok = await new Promise<boolean>((resolve) =>
      new ConfirmModal(this.app, `This creates or updates an index note in ${targets.length} folders. Only the part between the folder-index markers changes; anything else you wrote in an index note stays.`, resolve).open(),
    );
    if (!ok) return;
    const counts = { created: 0, updated: 0, same: 0, none: 0 };
    for (const folder of targets) counts[await this.safeUpdate(folder.path, true)]++;
    new Notice(`Indexes: ${counts.created} created, ${counts.updated} updated, ${counts.same} already current.`);
  }
}

class FolderIndexSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: FolderIndexNotesPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName('Keep indexes current')
      .setDesc('Update a folder\'s index note when notes are added, removed or renamed in it.')
      .addToggle((t) => t.setValue(s.autoUpdate).onChange(async (v) => { s.autoUpdate = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Create missing indexes')
      .setDesc('Also create an index note in a folder that has none. Off by default: use the command to create them once.')
      .addToggle((t) => t.setValue(s.autoCreate).onChange(async (v) => { s.autoCreate = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Index note name')
      .setDesc('Use {{folder}} for the folder name. Changing it does not rename indexes you already have.')
      .addText((t) => t.setValue(s.nameTemplate).onChange(async (v) => { s.nameTemplate = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Order')
      .addDropdown((d) =>
        d.addOption('name', 'A to Z').addOption('name-desc', 'Z to A').setValue(s.order).onChange(async (v) => {
          s.order = v === 'name-desc' ? 'name-desc' : 'name';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Folders heading')
      .setDesc('Leave empty for a plain list.')
      .addText((t) => t.setValue(s.foldersHeading).onChange(async (v) => { s.foldersHeading = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Notes heading')
      .setDesc('Leave empty for a plain list.')
      .addText((t) => t.setValue(s.notesHeading).onChange(async (v) => { s.notesHeading = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc('One per line. End with /* to skip the subfolders too, for example Archive/*.')
      .addTextArea((t) => t.setValue(s.excluded).onChange(async (v) => { s.excluded = v; await this.plugin.saveSettings(); }));
  }
}
