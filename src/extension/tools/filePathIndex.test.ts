import { describe, expect, it } from 'vitest';
import { FilePathIndex } from './filePathIndex';

describe('directory file index', () => {
  it('removes only descendants, including nested files and repeated basenames', () => {
    const index = new FilePathIndex();
    index.add('file:///root/sub/file', 'file');
    index.add('file:///root/sub/nested/file', 'file');
    index.add('file:///root/submarine/other', 'other');
    expect(index.remove('file:///root/sub/').sort()).toEqual(['file', 'file']);
    expect(index.remove('file:///root/sub')).toEqual([]);
    expect(index.remove('file:///root/submarine')).toEqual(['other']);
  });

  it('prunes empty directories and permits recreating deleted paths', () => {
    const index = new FilePathIndex();
    expect(index.add('file:///root/sub/file', 'file')).toBe(true);
    expect(index.add('file:///root/sub/file', 'duplicate')).toBe(false);
    expect(index.remove('file:///root/sub/file')).toEqual(['file']);
    expect(index.remove('file:///root/sub')).toEqual([]);
    expect(index.add('file:///root/sub/file', 'new')).toBe(true);
    expect(index.remove('file:///root')).toEqual(['new']);
    index.add('file:///root/sub/file', 'new');
    index.clear();
    expect(index.remove('file:///root')).toEqual([]);
    expect(index.add('file:///root/sub/file', 'new')).toBe(true);
  });

  it('keeps URI authorities and local roots separate', () => {
    const index = new FilePathIndex();
    index.add('file:///local/file', 'local');
    index.add('file://server/share/file', 'unc');
    index.add('vscode-remote://first/root/file', 'first');
    index.add('vscode-remote://second/root/file', 'second');
    expect(index.remove('file:///')).toEqual(['local']);
    expect(index.remove('vscode-remote://first/root')).toEqual(['first']);
    expect(index.remove('vscode-remote://second/root')).toEqual(['second']);
    expect(index.remove('file://server/share')).toEqual(['unc']);
  });

  it('handles many children without recursive traversal or argument spreading', () => {
    const index = new FilePathIndex();
    for (let child = 0; child < 10000; child++) {
      index.add(`file:///root/sub-${child}/file`, `${child}`);
    }
    expect(index.remove('file:///root')).toHaveLength(10000);
    expect(index.remove('file:///root')).toEqual([]);
  });
  it('retains observed empty directories only while folder tracking is enabled', () => {
    const added: string[] = [];
    const removed: string[] = [];
    const index = new FilePathIndex(
      (key) => added.push(key),
      (key) => removed.push(key)
    );
    index.setTrackDirectories(true);
    index.addDirectory('file:///root/project-empty/');
    index.add('file:///root/project-api/file', 'file');
    index.remove('file:///root/project-api/file');
    expect([...index.directoryKeys()]).toContain('file:///root/project-api');
    expect(
      added.filter((key) => key === 'file:///root/project-api')
    ).toHaveLength(1);
    index.remove('file:///root/project-empty');
    expect(removed).toContain('file:///root/project-empty');
    index.setTrackDirectories(false);
    expect([...index.directoryKeys()]).toEqual([]);
    index.add('file:///root/project-new/file', 'file');
    expect(index.remove('file:///root')).toEqual(['file']);
  });
  it('preserves nested workspace subtrees and still handles later physical deletions', () => {
    const index = new FilePathIndex();
    index.setTrackDirectories(true);
    index.add('file:///root/outside/file', 'outside');
    index.add('file:///root/child/inside/file', 'inside');
    index.addDirectory('file:///root/child/empty');
    expect(
      index.removeWorkspaceFolder('file:///root/', ['file:///root/child'])
    ).toEqual(['outside']);
    expect([...index.directoryKeys()]).toContain('file:///root/child/empty');
    expect([...index.directoryKeys()]).not.toContain('file:///root/outside');
    expect(index.add('file:///root/child/new/file', 'new')).toBe(true);
    expect(index.remove('file:///root/child').sort()).toEqual([
      'inside',
      'new',
    ]);
    expect([...index.directoryKeys()]).not.toContain(
      'file:///root/child/empty'
    );
  });

  it('does not confuse retained sibling roots with ancestors', () => {
    const index = new FilePathIndex();
    index.add('file:///root/child/file', 'removed');
    index.add('file:///root/child-other/file', 'retained');
    expect(
      index.removeWorkspaceFolder('file:///root/child', [
        'file:///root/child-other',
      ])
    ).toEqual(['removed']);
    expect(index.remove('file:///root/child-other')).toEqual(['retained']);
  });
});
