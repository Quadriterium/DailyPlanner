import { closeSync, fstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { parisDate } from '../shared/model.js';

export const maxDailyLogBytes = 5 * 1024 * 1024;
/** Room kept for the final marker line, so the file never exceeds the cap. */
const markerReserve = 256;

/** True when `child` is `parent` itself or lies inside it. */
export function isInside(child: string, parent: string) {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/**
 * One file per day (Paris time), `a-table-YYYY-MM-DD.log`, capped at `maxBytes`:
 * once the cap is reached a single marker line is written and the rest of the day only goes to the console.
 */
export class DailyLogFile {
  private day = '';
  private fd: number | null = null;
  private size = 0;
  private full = false;
  private failed = false;

  constructor(readonly directory: string, private readonly maxBytes = maxDailyLogBytes, private readonly now = () => new Date()) {
    mkdirSync(directory, { recursive: true });
  }

  write(line: string) {
    try {
      this.open();
      if (this.full || this.fd === null) return;
      const bytes = Buffer.from(line);
      if (this.size + bytes.length + markerReserve <= this.maxBytes) {
        this.size += writeSync(this.fd, bytes);
        return;
      }
      this.full = true;
      const marker = `${JSON.stringify({ level: 40, time: this.now().getTime(), msg: 'Limite quotidienne du journal atteinte : suite sur la console uniquement.' })}\n`;
      this.size += writeSync(this.fd, marker);
    } catch (error) {
      if (!this.failed) process.stderr.write(`Écriture du journal impossible dans ${this.directory} : ${error instanceof Error ? error.message : String(error)}\n`);
      this.failed = true;
    }
  }

  close() {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    this.day = '';
  }

  private open() {
    const day = parisDate(this.now());
    if (day === this.day) return;
    this.close();
    this.day = day;
    this.failed = false;
    this.fd = openSync(join(this.directory, `a-table-${day}.log`), 'a');
    this.size = fstatSync(this.fd).size;
    // A restart after the cap was reached must not write a second marker.
    this.full = this.size > this.maxBytes - markerReserve;
  }
}

/** Pino destination: every line goes to the console and to the daily file. */
export function consoleAndFile(file: DailyLogFile) {
  return { write(line: string) { process.stdout.write(line); file.write(line); } };
}
