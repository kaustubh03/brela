import * as fs from 'node:fs';
import * as path from 'node:path';
import { nanoid } from 'nanoid';

const SESSION_FILE = path.join('.brela', 'current-session');

export class SessionManager {
  private readonly sessionFile: string;

  constructor(projectRoot: string) {
    this.sessionFile = path.join(projectRoot, SESSION_FILE);
  }

  private brelaDir(): string {
    return path.dirname(this.sessionFile);
  }

  generateSessionId(): string {
    return nanoid(8);
  }

  getCurrentSession(): string {
    if (fs.existsSync(this.sessionFile)) {
      const id = fs.readFileSync(this.sessionFile, 'utf8').trim();
      if (id.length > 0) return id;
    }
    return this.rotateSession();
  }

  rotateSession(): string {
    const id = this.generateSessionId();
    fs.mkdirSync(this.brelaDir(), { recursive: true });
    fs.writeFileSync(this.sessionFile, id, 'utf8');
    return id;
  }
}
