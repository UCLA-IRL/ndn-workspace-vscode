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

export class File implements vscode.FileStat {
  type: vscode.FileType;
  ctime: number;
  mtime: number;
  size: number;
  permissions?: vscode.FilePermission;

  name: string;
  data?: Uint8Array;

  constructor(name: string) {
    this.type = vscode.FileType.File;
    this.ctime = Date.now();
    this.mtime = Date.now();
    this.size = 0;
    this.name = name;
    this.permissions = vscode.FilePermission.Readonly;
  }
}

export class Directory implements vscode.FileStat {
  type: vscode.FileType;
  ctime: number;
  mtime: number;
  size: number;
  permissions: vscode.FilePermission;

  name: string;
  entries: Map<string, File | Directory>;

  constructor(name: string) {
    this.type = vscode.FileType.Directory;
    this.ctime = Date.now();
    this.mtime = Date.now();
    this.size = 0;
    this.name = name;
    this.entries = new Map();
    this.permissions = vscode.FilePermission.Readonly;
  }
}

export type Entry = File | Directory;

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
        ctime: Date.now(),
        mtime: Date.now(),
        size: item.items.length,
        permissions: vscode.FilePermission.Readonly,
      };
    } else if (item?.kind === 'text') {
      return {
        type: vscode.FileType.File,
        ctime: Date.now(),
        mtime: Date.now(),
        size: item.text.length,
        permissions: vscode.FilePermission.Readonly,
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
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  delete(uri: vscode.Uri, options: { readonly recursive: boolean }): void | Thenable<void> {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): void | Thenable<void> {
    throw vscode.FileSystemError.NoPermissions(newUri);
  }

  // --- manage file events

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

    //
    yDoc.getMap('latex').observeDeep((events) => {
      const toFire = [] as vscode.FileChangeEvent[];

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
          if (evt instanceof Y.YArrayEvent) {
            // Directory changed
            // See evt.changes.added / deleted
          } else if (evt instanceof Y.YTextEvent) {
            // Text changed
          }
          toFire.push({
            type: vscode.FileChangeType.Changed,
            uri: vscode.Uri.parse(`ndnws:${itemPath}`),
          });
        }
      } // end forof

      this._emitter.fire(toFire);
    });
  }

  constructor() {}

  async disconnect() {
    await this.workspace?.destroy();
    this.workspace = undefined;
    this.face?.close();
    this.storage?.close();
  }

  async [Symbol.asyncDispose]() {
    await this.disconnect();
  }
}
