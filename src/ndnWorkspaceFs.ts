import * as path from 'path';
import * as Y from 'yjs';
import * as vscode from 'vscode';
import { Name, Signer, digestSigning } from '@ndn/packet';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { Workspace } from '@ucla-irl/ndnts-aux/workspace';
import * as project from './model/project';
import { Certificate } from '@ndn/keychain';
import { CertStorage } from '@ucla-irl/ndnts-aux/security';
import { Endpoint } from '@ndn/endpoint';
import { InMemoryStorage, Storage } from '@ucla-irl/ndnts-aux/storage';
import { WsTransport } from '@ndn/ws-transport';
import type { FwFace } from '@ndn/fw';
import * as nfdmgmt from '@ndn/nfdmgmt';
import { StringPositionCalculator } from './stringPositionCalculator';

export type RootDocType = {
  latex: project.Items;
};
export type RootDocStore = ReturnType<typeof syncedStore<RootDocType>>;

export function initRootDoc(guid: string) {
  return syncedStore(
    {
      latex: {},
    } as RootDocType,
    new Y.Doc({ guid }),
  );
}

export class WorkspaceFs implements vscode.FileSystemProvider {
  workspace?: Workspace;
  rootDoc?: RootDocStore;
  storage?: Storage;
  face?: FwFace;

  // Used to prevent self motivated change resuting in deadloop
  disableLocalUpdates: boolean = false;

  // --- Read content

  stat(uri: vscode.Uri): vscode.FileStat {
    if (!this.workspace) {
      throw vscode.FileSystemError.Unavailable(uri);
    }

    const parts = uri.path.split('/').slice(1);
    const itemId = project.itemIdAt(this.rootDoc!.latex, parts);
    if (!itemId) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const item = this.rootDoc!.latex[itemId];
    if (item?.kind === 'folder') {
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: 0,
        size: item.items.length,
        permissions: vscode.FilePermission.Readonly,
      };
    } else if (item?.kind === 'text') {
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: item.text.length,
      };
    } else {
      return {
        type: vscode.FileType.Unknown,
        ctime: 0,
        mtime: 0,
        size: 0,
        permissions: vscode.FilePermission.Readonly,
      };
    }
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    if (!this.workspace) {
      return [];
    }
    const parts = uri.path.split('/').slice(1);
    const itemId = project.itemIdAt(this.rootDoc!.latex, parts);
    if (!itemId) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const item = this.rootDoc!.latex[itemId];
    if (item?.kind !== 'folder') {
      throw vscode.FileSystemError.FileNotADirectory(uri);
    }
    return item.items.map((itemId) => {
      const subItem = this.rootDoc?.latex[itemId];
      if (subItem?.kind === 'folder') {
        return [subItem.name, vscode.FileType.Directory];
      } else if (subItem?.kind === 'text') {
        return [subItem.name, vscode.FileType.File];
      } else {
        return [subItem?.name ?? '', vscode.FileType.Unknown];
      }
    });
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    if (!this.workspace) {
      throw vscode.FileSystemError.Unavailable(uri);
    }
    const parts = uri.path.split('/').slice(1);
    const itemId = project.itemIdAt(this.rootDoc!.latex, parts);
    if (!itemId) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const item = this.rootDoc!.latex[itemId];
    if (item?.kind === 'folder') {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    if (item?.kind === 'text') {
      return new TextEncoder().encode(item.text.toString());
    } else if (item?.kind === 'blob') {
      const value = await this.workspace.syncAgent.getBlob(new Name(item.blobName));
      if (value !== undefined) {
        return value;
      } else {
        throw vscode.FileSystemError.Unavailable(uri);
      }
    } else {
      throw vscode.FileSystemError.Unavailable(uri);
    }
  }

  // --- modification is not allowed

  createDirectory(uri: vscode.Uri): void | Thenable<void> {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): void | Thenable<void> {
    // "Doing nothing during write of remote file, the remote file is probably just told to save"
    // throw vscode.FileSystemError.NoPermissions(uri);
    return;
  }
  delete(uri: vscode.Uri, options: { readonly recursive: boolean }): void | Thenable<void> {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): void | Thenable<void> {
    throw vscode.FileSystemError.NoPermissions(newUri);
  }

  // --- manage file events
  // CollaborationFs does not fire events except Delete.

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

  watch(
    _uri: vscode.Uri,
    _options: { readonly recursive: boolean; readonly excludes: readonly string[] },
  ): vscode.Disposable {
    // ignore, fires for all changes...
    return new vscode.Disposable(() => {});
  }

  public async initialize(trustAnchor: Certificate, cert: Certificate, prvKey: Uint8Array) {
    if (this.workspace !== undefined) {
      return;
    }

    const endpoint = new Endpoint();
    this.storage = new InMemoryStorage();
    const certStore = new CertStorage(trustAnchor, cert, this.storage, endpoint, prvKey);
    this.face = await WsTransport.createFace({ l3: { local: true } }, 'ws://localhost:9696/');

    await nfdmgmt.invoke(
      'rib/register',
      {
        name: cert.name.getPrefix(cert.name.length - 5),
        origin: 65, // client
        cost: 0,
        flags: 0x02, // CAPTURE
      },
      {
        endpoint: endpoint,
        prefix: nfdmgmt.localhostPrefix,
        signer: digestSigning,
      },
    );
    await nfdmgmt.invoke(
      'rib/register',
      {
        name: cert.name.getPrefix(cert.name.length - 4),
        origin: 65, // client
        cost: 0,
        flags: 0x02, // CAPTURE
      },
      {
        endpoint: endpoint,
        prefix: nfdmgmt.localhostPrefix,
        signer: digestSigning,
      },
    );

    this.rootDoc = initRootDoc(project.WorkspaceDocId);
    const yDoc = getYjsDoc(this.rootDoc);

    // Load or create
    const createNewDoc: (() => Promise<void>) | undefined = async () => {
      const clientID = yDoc.clientID;
      yDoc.clientID = 1; // Set the client Id to be a common one to make the change common
      this.rootDoc!.latex[project.RootId] = {
        id: project.RootId,
        name: '',
        parentId: undefined,
        kind: 'folder',
        items: [],
      };
      yDoc.clientID = clientID;
    };

    this.workspace = await Workspace.create({
      nodeId: cert.name.getPrefix(cert.name.length - 4),
      persistStore: this.storage,
      endpoint,
      rootDoc: yDoc,
      signer: certStore.signer,
      verifier: certStore.verifier,
      createNewDoc,
      useBundler: true,
    });

    // Listen to remote
    yDoc.getMap('latex').observeDeep(async (events, transact) => {
      const toFire = [] as vscode.FileChangeEvent[];

      if (transact.origin === this) {
        // Prevent self motivate
        return;
      }

      for (const evt of events) {
        if (evt.path.length === 0) {
          // New Item, pushed at root
          for (const [itemId, v] of evt.keys.entries()) {
            if (v.action !== 'add') {
              console.log(`Unexpected action: ${itemId} ${v.action}`);
              continue;
            }
            const itemPath = project.getFullPath(this.rootDoc!.latex, this.rootDoc!.latex[itemId]);
            console.log(`Created: ${vscode.Uri.parse(`ndnws:${itemPath}`)}`);
            toFire.push({
              type: vscode.FileChangeType.Created,
              uri: vscode.Uri.parse(`ndnws:${itemPath}`),
            });
          }
        } else {
          // Otherwise, subdir or item
          const itemId = evt.path[0];
          const itemPath = project.getFullPath(this.rootDoc!.latex, this.rootDoc!.latex[itemId]);
          const itemUri = vscode.Uri.parse(`ndnws:${itemPath}`);
          if (evt instanceof Y.YArrayEvent) {
            // Directory changed
            // See evt.changes.added / deleted
          } else if (evt instanceof Y.YTextEvent) {
            // Text changed
            const editor = vscode.window.visibleTextEditors.find((cur) => cur.document.uri.path === itemPath);
            const currentText = (this.rootDoc!.latex[itemId] as project.TextDoc).text.toString();
            // TODO: Remove delete when dirty is not showing up
            this.disableLocalUpdates = true;
            await editor?.edit((builder) => {
              let position = 0;
              for (const delta of evt.changes.delta) {
                if (delta.retain) {
                  position += delta.retain;
                } else if (delta.delete) {
                  builder.delete(
                    new vscode.Range(
                      StringPositionCalculator.indexToLineAndCharacter(currentText, position),
                      StringPositionCalculator.indexToLineAndCharacter(currentText, position + delta.delete),
                    ),
                  );
                } else if (delta.insert) {
                  builder.insert(
                    StringPositionCalculator.indexToLineAndCharacter(currentText, position),
                    delta.insert as string,
                  );
                  position += delta.insert.length;
                }
              }
            });
            this.disableLocalUpdates = false;
          } // end if
          toFire.push({
            type: vscode.FileChangeType.Changed,
            uri: itemUri,
          });
        }
      } // end forof

      this._emitter.fire(toFire);
    });

    // Listen to local windows
    vscode.workspace.onDidChangeTextDocument((evt) => {
      if (evt.document.uri.scheme !== 'ndnws') {
        return;
      }
      if (!this.disableLocalUpdates) {
        const parts = evt.document.uri.path.split('/').slice(1);
        const itemId = project.itemIdAt(this.rootDoc!.latex, parts);
        if (!itemId) {
          return;
        }
        const item = this.rootDoc!.latex[itemId];
        if (item?.kind !== 'text') {
          return;
        }
        getYjsDoc(this.rootDoc).transact(() => {
          for (const change of evt.contentChanges) {
            const { start, end } = change.range; // old positions
            const currentText = item.text.toString();
            let startIndex = StringPositionCalculator.lineAndCharacterToIndex(currentText, start);
            let endIndex = StringPositionCalculator.lineAndCharacterToIndex(currentText, end);
            if (endIndex > startIndex) {
              item.text.delete(startIndex, endIndex - startIndex);
            }
            if (change.text) {
              item.text.insert(startIndex, change.text);
            }
          }
        }, this);
      }
      evt.document.save();
    });
    // vscode.workspace.onDidOpenTextDocument((evt) => {
    //   // console.log(evt.uri);
    // });
    // vscode.workspace.onDidCloseTextDocument((evt) => {});

    this.workspace.fireUpdate();
  }

  constructor() {}

  async disconnect() {
    await this.workspace?.destroy();
    this.workspace = undefined;
    if (this.rootDoc !== undefined) {
      getYjsDoc(this.rootDoc).destroy();
      this.rootDoc = undefined;
    }
    this.face?.close();
    this.storage?.close();
  }

  async [Symbol.asyncDispose]() {
    await this.disconnect();
  }
}
