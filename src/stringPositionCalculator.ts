import * as vscode from 'vscode';

export class StringPositionCalculator {
  static lineAndCharacterToIndex(text: string, position: vscode.Position): number {
    let line = 0;
    let character = 0;

    for (let i = 0; i < text.length; i++) {
      if (line === position.line && character === position.character) {
        return i;
      }
      if (text.charAt(i) === '\r') {
        if (!(i + 1 < text.length && text.charAt(i + 1) === '\n')) {
          line++;
          character = 0;
        }
      } else if (text.charAt(i) === '\n') {
        line++;
        character = 0;
      } else {
        character++;
      }
    }
    return text.length;
  }

  static indexToLineAndCharacter(text: string, position: number): vscode.Position {
    let line = 0;
    let character = 0;

    for (let i = 0; i < Math.min(text.length, position); i++) {
      if (text.charAt(i) === '\r') {
        if (!(i + 1 < text.length && text.charAt(i + 1) === '\n')) {
          line++;
          character = 0;
        }
      } else if (text.charAt(i) === '\n') {
        line++;
        character = 0;
      } else {
        character++;
      }
    }
    return new vscode.Position(line, character);
  }
}
