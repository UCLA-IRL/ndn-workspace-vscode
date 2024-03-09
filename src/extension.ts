import * as vscode from 'vscode';
import { WorkspaceFs } from './ndnWorkspaceFs';
import { base64ToBytes } from '@ucla-irl/ndnts-aux/utils';
import { Decoder } from '@ndn/tlv';
import { Data } from '@ndn/packet';
import { Certificate } from '@ndn/keychain';
import { SafeBag } from '@ndn/ndnsec';

export function activate(context: vscode.ExtensionContext) {
  console.log('NdnWorkspaceFs says "Hello"');

  const ndnWs = new WorkspaceFs();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('ndnws', ndnWs, { isCaseSensitive: true, isReadonly: false }),
  );
  let initialized = false;

  context.subscriptions.push(
    vscode.commands.registerCommand('ndnws.reset', async (_) => {
      if (!initialized) {
        return;
      }
      await ndnWs.disconnect();
      initialized = false;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ndnws.init', async (_) => {
      if (initialized) {
        return;
      }
      initialized = true;

      const config = vscode.workspace.getConfiguration('ndnws');
      const trustAnchorB64 = config.get<string>('trustAnchor');
      const safeBagB64 = config.get<string>('safeBag');
      const passCode = config.get<string>('passCode');
      if (!trustAnchorB64) {
        console.log(`No trust anchor.`);
        return;
      }
      const trustAnchor = decodeCert(trustAnchorB64);
      console.log(`Trust Anchor: ${trustAnchor.name.toString()}`);

      if (!safeBagB64 || !passCode) {
        console.log(`No safe bag.`);
        return;
      }
      const { cert, prvKey } = await decodeSafebag(safeBagB64, passCode);
      console.log(`My Cert: ${cert.name.toString()}`);
      await ndnWs.initialize(trustAnchor, cert, prvKey);
      console.log(`Loaded.`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ndnws.workspaceInit', (_) => {
      vscode.workspace.updateWorkspaceFolders(0, 0, { uri: vscode.Uri.parse('ndnws:/'), name: 'NDN Workspace' });
    }),
  );
}

const decodeCert = (b64Value: string) => {
  const wire = base64ToBytes(b64Value);
  const data = Decoder.decode(wire, Data);
  const cert = Certificate.fromData(data);
  return cert;
};

const decodeSafebag = async (b64Value: string, passcode: string) => {
  const wire = base64ToBytes(b64Value);
  const safebag = Decoder.decode(wire, SafeBag);
  const cert = safebag.certificate;
  const prvKey = await safebag.decryptKey(passcode);
  return { cert, prvKey };
};
